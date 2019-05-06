<template>
  <div>
    <input type="text" v-model="serverUrl"><br>
    <input type="text" v-model="screenId" placeholder="Input screen ID"><br>
    <input type="text" v-model="passphrase" placeholder="Input passphrase"><br>
    <button v-on:click="shareScreen()">Share your screen</button> or
    <button v-on:click="viewScreen()">View screen</button>
    <!--  Player  -->
    <div>
      <video ref="video0"></video>
      <video ref="video1" style="display: none"></video>
    </div>
  </div>
</template>

<script lang="ts">
/* tslint:disable:no-console */
import { Component, Prop, Vue } from 'vue-property-decorator';
import MediaStreamRecorder from 'msr';

function blobToArrayBuffer(blob: Blob): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const fileReader = new FileReader();
    fileReader.onload = () => {
      resolve(fileReader.result as ArrayBuffer);
    };
    fileReader.onerror = () => {
      reject(fileReader.error);
    };
    fileReader.readAsArrayBuffer(blob);
  });
}

function createServerUrl(baseServerUrl: string, screenId: string, chunkNum: number) {
  // TODO: Use join-url
  // TODO: Use digest-hash not to give information for Piping Server
  return `${baseServerUrl}/screen-share-web/${screenId}/${chunkNum}`;
}

async function passphraseToKey(passphrase: string): Promise<Uint8Array> {
  // Convert passphrase string to Uint8Array
  const passphraseU8Array: Uint8Array = new TextEncoder().encode(passphrase);
  // Generate key from passphrase by SHA-2156
  const key = new Uint8Array(await crypto.subtle.digest('SHA-256', passphraseU8Array));
  return key;
}

// AES-GCM (Initial Vector (IV) is attached on the head)
const IvAesGcm = {
  ivLen: 12,

  async createCryptoKey(passphrase: string): Promise<CryptoKey> {
    const passphraseDigest = await passphraseToKey(passphrase);
    return crypto.subtle.importKey(
      'raw',
      passphraseDigest,
      {name: 'AES-GCM', length: 128},
      false,
      ['encrypt', 'decrypt'],
    );
  },

  // NOTE: Return-type of encrypt and decrypt is not symmetric.
  async encryptAsBlob(raw: ArrayBuffer, passphrase: string): Promise<Blob> {
    // Create IV
    const iv = window.crypto.getRandomValues(new Uint8Array(this.ivLen));
    // Create key from passphrase
    const cryptoKey = await this.createCryptoKey(passphrase);
    // Encrypt
    const encrypted = await crypto.subtle.encrypt(
      {name: 'AES-GCM', iv},
      cryptoKey,
      raw,
    );
    return new Blob([iv, encrypted]);
  },

  // NOTE: Return-type of encrypt and decrypt is not symmetric.
  async decryptAsArrayBuffer(encryptedWithIv: ArrayBuffer, passphrase: string): Promise<ArrayBuffer> {
    // Extract IV and encrypted parts
    const iv = encryptedWithIv.slice(0, this.ivLen);
    const encrypted = encryptedWithIv.slice(this.ivLen);
    // Create key from passphrase
    const cryptoKey = await this.createCryptoKey(passphrase);
    return crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      cryptoKey,
      encrypted,
    );
  },
};

@Component
export default class PipingScreenShare extends Vue {

  private serverUrl: string = 'https://ppng.ml';
  private screenId: string = '';
  private passphrase: string = '';

  get video0(): HTMLVideoElement {
    return this.$refs.video0 as HTMLVideoElement;
  }

  get video1(): HTMLVideoElement {
    return this.$refs.video1 as HTMLVideoElement;
  }

  private async shareScreen() {
    if (!('getDisplayMedia' in navigator.mediaDevices)) {
      console.error('getDisplayMedia is required');
      return;
    }

    const stream = await (navigator.mediaDevices as any).getDisplayMedia({video: true});
    const mediaRecorder = new MediaStreamRecorder(stream);
    mediaRecorder.mimeType = 'video/mp4';

    let chunkNum = 1;
    mediaRecorder.ondataavailable = async (blob: Blob) => {
      // Encrypt
      const encryptedBlob: Blob = await IvAesGcm.encryptAsBlob(
        await blobToArrayBuffer(blob),
        this.passphrase,
      );

      // Send a blob
      fetch(createServerUrl(this.serverUrl, this.screenId, chunkNum), {
        method: 'POST',
        body: encryptedBlob,
      });
      chunkNum++;
    };

    mediaRecorder.start(500);
  }

  private async viewScreen() {
    // Queue of blob URL
    const blobUrlQueue: string[] = [];
    let active: HTMLVideoElement = this.video0;
    let hidden: HTMLVideoElement = this.video1;

    // For waiting the buffer filled
    let waitDoubleBufferResolve: (() => void) | null = null;

    // Double-buffered
    async function doubleBuffer() {
      await new Promise((resolve) => {
        if (blobUrlQueue.length === 0) {
          waitDoubleBufferResolve = resolve;
        } else {
          resolve();
        }
      });
      console.log('double buffer called');
      // Revoke active blob URL because its play has ended
      URL.revokeObjectURL(active.src);
      // Swap video elements
      [active, hidden] = [hidden, active];
      active.play();
      // NOTE: It is never undefined logically because the queue is not empty
      const blobUrl: string = blobUrlQueue.shift() as string;
      hidden.src = blobUrl;
      active.style.display = null;
      hidden.style.display = 'none';
    }

    // Subscribe ended
    active.onended = doubleBuffer;
    hidden.onended = doubleBuffer;

    let firstPlayDone = false;

    for (let chunkNum = 1; ; chunkNum++) {
      // Get a chunk
      const res = await fetch(createServerUrl(this.serverUrl, this.screenId, chunkNum));

      // Decrypt
      const decrypted: ArrayBuffer = await IvAesGcm.decryptAsArrayBuffer(
        await res.arrayBuffer(),
        this.passphrase,
      );

      // Get a blob
      const blob: Blob = new Blob([decrypted], {type: 'video/mp4'});

      if (blob.size === 0) {
        console.log('blob is empty');
        break;
      }

      // Push the blob URL
      const blobUrl = URL.createObjectURL(blob);
      blobUrlQueue.push(blobUrl);

      if (!firstPlayDone && blobUrlQueue.length >= 2) {
        // NOTE: There are never undefined logically because the length queue is over 1
        active.src = blobUrlQueue.shift() as string;
        hidden.src = blobUrlQueue.shift() as string;
        active.play();
        firstPlayDone = true;
      } else {
        // NOTE: You can chane the threshold >= n
        if (blobUrlQueue.length >= 1 && waitDoubleBufferResolve !== null) {
          // Resolve
          waitDoubleBufferResolve();
          // Release
          waitDoubleBufferResolve = null;
        }
      }
    }
  }
}
</script>

<!-- Add "scoped" attribute to limit CSS to this component only -->
<style scoped>
h3 {
  margin: 40px 0 0;
}
ul {
  list-style-type: none;
  padding: 0;
}
li {
  display: inline-block;
  margin: 0 10px;
}
a {
  color: #42b983;
}
video {
  width: 100%;
}
</style>
