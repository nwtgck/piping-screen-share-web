<template>
  <v-container fluid text-xs-center>
    <v-layout row wrap>
      <!--  Share or View toggle buttons  -->
      <v-flex xs12 style="margin-bottom: 1em;">
        <v-btn-toggle v-model="shareOrView" mandatory>
          <v-btn text value="share">
            Share
            <v-icon right dark>screen_share</v-icon>
          </v-btn>
          <v-btn text value="view">
            View
            <v-icon right dark>computer</v-icon>
          </v-btn>
        </v-btn-toggle>
      </v-flex>

      <!-- Player -->
      <v-flex v-if="shareOrView === 'view'" xs12 sm10 offset-sm1>
        <fullscreen ref="fullscreen">
          <video ref="video0" style="display: none"></video>
          <video ref="video1" style="display: none"></video>
        </fullscreen>
        <!-- Turn fullscreen on -->
        <v-icon v-if="showFullscreenButton"
                v-on:click="toggleFullscreen()"
                style="font-size: 2em;">
          fullscreen
        </v-icon>
      </v-flex>

      <v-flex xs12 sm8 offset-sm2 offset-md3 md6>
        <v-card style="padding: 1em;">
          <!-- Server URL -->
          <v-text-field type="text" v-model="serverUrl" label="Server URL" />
          <!-- Screen ID -->
          <v-text-field type="text" v-model="screenId" label="Screen ID" placeholder="Input screen ID" />
          <!-- Passphrase -->
          <v-text-field label="Passphrase (optional)"
                        v-model="passphrase"
                        placeholder="Input passphrase"
                        :type="showPassphrase ? 'text' : 'password'"
                        :append-icon="showPassphrase ? 'visibility' : 'visibility_off'"
                        @click:append="showPassphrase = !showPassphrase"
          />

          <v-btn v-if="shareOrView === 'share'"
                 color="primary"
                 v-on:click="shareScreen()"
                 block
                 :disabled="!enableActionButton">
            Share
            <v-icon right dark>screen_share</v-icon>
          </v-btn>

          <v-btn v-if="shareOrView === 'view'"
                 color="secondary"
                 v-on:click="viewScreen()"
                 block
                 :disabled="!enableActionButton">
            View
            <v-icon right dark>computer</v-icon>
          </v-btn>
        </v-card>
      </v-flex>
    </v-layout>
  </v-container>
</template>

<script lang="ts">
/* tslint:disable:no-console */
import {Component, Vue} from 'vue-property-decorator';
import MediaStreamRecorder from 'msr';
import Fullscreen from 'vue-fullscreen/src/component.vue';
import urlJoin from 'url-join';
import * as t from 'io-ts';

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
  // TODO: Use digest-hash not to give information for Piping Server
  return urlJoin(baseServerUrl, `screen-share-web/${screenId}/${chunkNum}`);
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

function encodeSeqNum(seqNum: number): ArrayBuffer {
  const view = new DataView(new ArrayBuffer(4));
  view.setUint32(0, seqNum, false);
  return view.buffer;
}

function decodeSeqNum(buf: ArrayBuffer): number {
  return new DataView(buf).getUint32(0, false);
}

function parseHashAsQuery(): URLSearchParams {
  const url = new URL(`a://a${location.hash.substring(1)}`);
  return url.searchParams;
}

@Component({
  components: {
    Fullscreen,
  },
})
export default class PipingScreenShare extends Vue {
  public readonly $refs!: {
    video0: HTMLVideoElement,
    video1: HTMLVideoElement,
    fullscreen: any,
  };

  private shareOrView: 'share' | 'view' = (() => {
    const type = parseHashAsQuery().get('type');
    if (type === null) {
      return 'share' as const;
    }
    const typeEither = t.union([t.literal('share'), t.literal('view')]).decode(type);
    if (typeEither._tag === 'Left') {
      return 'share' as const;
    }
    return typeEither.right;
  })();
  private serverUrl: string = parseHashAsQuery().get('server') ?? 'https://ppng.io';
  private screenId: string = parseHashAsQuery().get('screen_id') ?? '';
  private passphrase: string = '';
  private showPassphrase: boolean = false;
  private enableActionButton: boolean = true;
  private showFullscreenButton: boolean = false;

  private async shareScreen() {
    if (!('getDisplayMedia' in navigator.mediaDevices)) {
      console.error('getDisplayMedia is required');
      return;
    }

    // Disable the button
    this.enableActionButton = false;

    const seqNumToAbortController: Map<number, AbortController> = new Map();

    const stream = await (navigator.mediaDevices as any).getDisplayMedia({video: true});
    const mediaRecorder = new MediaStreamRecorder(stream);
    mediaRecorder.mimeType = 'video/mp4';

    let seqNum = 0;
    mediaRecorder.ondataavailable = async (blob: Blob) => {
      // Encrypt
      const encryptedBlob: Blob = await IvAesGcm.encryptAsBlob(
        await blobToArrayBuffer(new Blob([encodeSeqNum(seqNum), blob])),
        this.passphrase,
      );

      const existingAbortController: AbortController | undefined = seqNumToAbortController.get(seqNum);
      if (existingAbortController !== undefined) {
        seqNumToAbortController.delete(seqNum);
        existingAbortController.abort();
      }

      const abortController = new AbortController();
      // Send a blob
      fetch(createServerUrl(this.serverUrl, this.screenId, seqNum % 2), {
        method: 'POST',
        body: encryptedBlob,
        signal: abortController.signal,
      });
      seqNumToAbortController.set(seqNum, abortController);
      seqNum++;
    };

    mediaRecorder.start(500);
  }

  private async viewScreen() {
    // Disable the button
    this.enableActionButton = false;

    // Queue of blob URL
    const blobUrlQueue: Array<{ blobUrl: string, seqNum: number }> = [];
    let active: HTMLVideoElement = this.$refs.video0;
    let hidden: HTMLVideoElement = this.$refs.video1;

    // For waiting the buffer filled
    let waitDoubleBufferResolve: (() => void) | null = null;
    // Played seq number
    let prevPlayedSeqNum: number | undefined;

    // Double-buffered
    async function doubleBuffer() {
      await new Promise<void>((resolve) => {
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
      const {blobUrl, seqNum} = blobUrlQueue.shift()!;
      prevPlayedSeqNum = seqNum;
      hidden.src = blobUrl;
      active.style.display = '';
      hidden.style.display = 'none';
    }

    // Subscribe ended
    active.onended = doubleBuffer;
    hidden.onended = doubleBuffer;

    let firstPlayDone = false;

    const load = async (cycleNum: number): Promise<{res: Response, cycleNum: number}> => {
      try {
        const res = await fetch(createServerUrl(this.serverUrl, this.screenId, cycleNum));
        if (res.status !== 200) {
          throw new Error(`status is not 200, ${res.status}`);
        }
        return {
          res,
          cycleNum,
        };
      } catch (e) {
        setTimeout(() => {
          cyclePromises[cycleNum] = load(cycleNum);
        }, 1000);
        throw e;
      }
    };

    const cyclePromises: Array<Promise<{res: Response, cycleNum: number}>> = [
      load(0),
      load(1),
    ];

    while (true) {
      try {
        // Get a chunk
        const {res, cycleNum} = await Promise.any(cyclePromises);
        // Get body
        const encryptedBuffer = await res.arrayBuffer();
        // Request
        cyclePromises[cycleNum] = load(cycleNum);
        // Decrypt
        const decrypted: ArrayBuffer = await IvAesGcm.decryptAsArrayBuffer(
            encryptedBuffer,
            this.passphrase,
        );

        // Get seq number
        const seqNum = decodeSeqNum(decrypted.slice(0, 4));

        // Skip if the screen is older than played one
        if (prevPlayedSeqNum !== undefined && seqNum < prevPlayedSeqNum) {
          continue;
        }

        // Get a blob
        const blob: Blob = new Blob([decrypted.slice(4)], {type: 'video/mp4'});

        if (blob.size === 0) {
          console.log('blob is empty');
          break;
        }

        // Push the blob URL
        const blobUrl = URL.createObjectURL(blob);
        blobUrlQueue.push({
          blobUrl,
          seqNum,
        });

        if (!firstPlayDone && blobUrlQueue.length >= 2) {
          // NOTE: There are never undefined logically because the length queue is over 1
          // FIXME: reorder blob by seq number
          active.src = blobUrlQueue.shift()!.blobUrl;
          hidden.src = blobUrlQueue.shift()!.blobUrl;
          active.play();
          firstPlayDone = true;
          // Enable show fullscreen button
          this.showFullscreenButton = true;
        } else {
          // NOTE: You can chane the threshold >= n
          if (blobUrlQueue.length >= 1 && waitDoubleBufferResolve !== null) {
            // Resolve
            waitDoubleBufferResolve();
            // Release
            waitDoubleBufferResolve = null;
          }
        }
      } catch (e) {
        console.error(e);
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  }

  private toggleFullscreen() {
    this.$refs.fullscreen.toggle();
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
