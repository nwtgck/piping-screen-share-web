<template>
  <v-container text-xs-center>
    <v-row wrap>
      <!--  Share or View toggle buttons  -->
      <v-container xs12 style="margin-bottom: 1em;">
        <v-btn-toggle v-model="shareOrView" mandatory>
          <v-btn variant="text" value="share">
            Share
            <v-icon right dark>{{ mdiMonitorShare }}</v-icon>
          </v-btn>
          <v-btn variant="text" value="view">
            View
            <v-icon right dark>{{ mdiMonitor }}</v-icon>
          </v-btn>
        </v-btn-toggle>
      </v-container>

      <!-- Player -->
      <div v-if="shareOrView === 'view'" xs12 sm10 offset-sm1>
        <div ref="videoContainerRef">
          <video ref="video0Ref" style="display: none"></video>
          <video ref="video1Ref" style="display: none"></video>
        </div>
        <!-- Turn fullscreen on -->
        <v-icon v-if="showFullscreenButton"
                v-on:click="fullScreen()"
                style="font-size: 2em;">
          {{ mdiFullscreen }}
        </v-icon>
      </div>

      <v-container xs12 sm8 offset-sm2 offset-md3 md6>
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
                        :append-icon="showPassphrase ? mdiEye : mdiEyeOff"
                        @click:append="showPassphrase = !showPassphrase"
          />

          <v-btn v-if="shareOrView === 'share'"
                 color="primary"
                 v-on:click="shareScreen()"
                 :disabled="!enableActionButton"
                 style="width: 100%">
            Share
            <v-icon right dark>{{ mdiMonitorShare }}</v-icon>
          </v-btn>

          <v-btn v-if="shareOrView === 'view'"
                 color="secondary"
                 v-on:click="viewScreen()"
                 :disabled="!enableActionButton"
                 style="width: 100%">
            View
            <v-icon right dark>{{ mdiMonitor }}</v-icon>
          </v-btn>
        </v-card>
      </v-container>
    </v-row>
  </v-container>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import MediaStreamRecorder from 'msr';
import urlJoin from 'url-join';
import * as t from 'io-ts';
import screenfull from 'screenfull';
import {mdiEye, mdiEyeOff, mdiMonitorShare, mdiMonitor, mdiFullscreen} from "@mdi/js";

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

function encodeTimestamp(timestamp: bigint): ArrayBuffer {
  const view = new DataView(new ArrayBuffer(8));
  view.setBigUint64(0, timestamp, false);
  return view.buffer;
}

function decodeTimestamp(buf: ArrayBuffer): bigint {
  return new DataView(buf).getBigUint64(0, false);
}

function parseHashAsQuery(): URLSearchParams {
  const url = new URL(`a://a${location.hash.substring(1)}`);
  return url.searchParams;
}

const video0Ref = ref<HTMLVideoElement>();
const video1Ref = ref<HTMLVideoElement>();
const videoContainerRef = ref<HTMLDivElement>();

const shareOrView = ref<'share' | 'view'>((() => {
  const type = parseHashAsQuery().get('type');
  if (type === null) {
    return 'share' as const;
  }
  const typeEither = t.union([t.literal('share'), t.literal('view')]).decode(type);
  if (typeEither._tag === 'Left') {
    return 'share' as const;
  }
  return typeEither.right;
})());

const serverUrl = ref<string>(parseHashAsQuery().get('server') ?? 'https://ppng.io');
const screenId = ref<string>(parseHashAsQuery().get('screen_id') ?? '');
const passphrase = ref<string>('');
const showPassphrase = ref<boolean>(false);
const enableActionButton = ref<boolean>(true);
const showFullscreenButton = ref<boolean>(false);

async function shareScreen() {
  if (!('getDisplayMedia' in navigator.mediaDevices)) {
    console.error('getDisplayMedia is required');
    return;
  }

  // Disable the button
  enableActionButton.value = false;

  const timestampToAbortController: Map<bigint, AbortController> = new Map();

  const stream = await (navigator.mediaDevices as any).getDisplayMedia({video: true});
  const mediaRecorder = new MediaStreamRecorder(stream);
  mediaRecorder.mimeType = 'video/mp4';

  let chunkNum = 0;
  mediaRecorder.ondataavailable = async (blob: Blob) => {
    const timestamp: bigint = BigInt(Date.now());

    // Encrypt
    const encryptedBlob: Blob = await IvAesGcm.encryptAsBlob(
      await blobToArrayBuffer(new Blob([encodeTimestamp(timestamp), blob])),
      passphrase.value,
    );

    const existingAbortController: AbortController | undefined = timestampToAbortController.get(timestamp);
    if (existingAbortController !== undefined) {
      timestampToAbortController.delete(timestamp);
      existingAbortController.abort();
    }

    const abortController = new AbortController();
    // Send a blob
    fetch(createServerUrl(serverUrl.value, screenId.value, chunkNum), {
      method: 'POST',
      body: encryptedBlob,
      signal: abortController.signal,
    });
    timestampToAbortController.set(timestamp, abortController);
    chunkNum = (chunkNum + 1) % 2;
  };

  mediaRecorder.start(500);
}

async function viewScreen() {
  // Disable the button
  enableActionButton.value = false;

  // Queue of blob URL
  const blobUrlQueue: Array<{ blobUrl: string, timestamp: bigint }> = [];
  let active: HTMLVideoElement = video0Ref.value!;
  let hidden: HTMLVideoElement = video1Ref.value!;

  // For waiting the buffer filled
  let waitDoubleBufferResolve: (() => void) | null = null;
  // Played seq number
  let prevPlayedTimestamp: bigint | undefined;

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
    const {blobUrl, timestamp} = blobUrlQueue.shift()!;
    prevPlayedTimestamp = timestamp;
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
      const res = await fetch(createServerUrl(serverUrl.value, screenId.value, cycleNum));
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
          passphrase.value,
      );

      // Get seq number
      const timestamp = decodeTimestamp(decrypted.slice(0, 8));
      console.log("timestamp=", timestamp, new Date(Number(timestamp)));

      // Skip if the screen is older than played one
      if (prevPlayedTimestamp !== undefined && timestamp < prevPlayedTimestamp) {
        console.log("skip", "prevPlayedTimestamp=", prevPlayedTimestamp, "timestamp=", timestamp);
        continue;
      }

      // Get a blob
      const blob: Blob = new Blob([decrypted.slice(8)], {type: 'video/mp4'});

      if (blob.size === 0) {
        console.log('blob is empty');
        break;
      }

      // Push the blob URL
      const blobUrl = URL.createObjectURL(blob);
      blobUrlQueue.push({
        blobUrl,
        timestamp,
      });

      if (!firstPlayDone && blobUrlQueue.length >= 2) {
        // NOTE: There are never undefined logically because the length queue is over 1
        // FIXME: reorder blob by seq number
        active.src = blobUrlQueue.shift()!.blobUrl;
        hidden.src = blobUrlQueue.shift()!.blobUrl;
        active.play();
        firstPlayDone = true;
        // Enable show fullscreen button
        showFullscreenButton.value = true;
      } else {
        // NOTE: You can chane the threshold >= n
        if (blobUrlQueue.length >= 1 && waitDoubleBufferResolve !== null) {
          // Resolve
          waitDoubleBufferResolve!();
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

function fullScreen() {
  if (screenfull.isEnabled) {
    screenfull.request(videoContainerRef.value!);
  } else {
    console.warn("full screen is not enabled");
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
