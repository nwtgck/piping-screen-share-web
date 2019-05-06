<template>
  <div>
    <input type="text" v-model="serverUrl"><br>
    <input type="text" v-model="screenId" placeholder="Input screen ID"><br>
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

function createServerUrl(baseServerUrl: string, screenId: string, chunkNum: number) {
  // TODO: Use join-url
  // TODO: Use digest-hash not to give information for Piping Server
  return `${baseServerUrl}/screen-share-web/${screenId}/${chunkNum}`;
}

@Component
export default class PipingScreenShare extends Vue {

  private serverUrl: string = 'https://ppng.ml';
  private screenId: string = '';

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
    mediaRecorder.ondataavailable = (blob: Blob) => {
      // Send a blob
      fetch(createServerUrl(this.serverUrl, this.screenId, chunkNum), {
        method: 'POST',
        body: blob,
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
      // Get a blob
      const blob: Blob = new Blob([await res.arrayBuffer()], {type: 'video/mp4'});

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
