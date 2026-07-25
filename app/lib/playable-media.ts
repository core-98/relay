const MIME_BY_EXTENSION: Record<string, string> = {
  mp4: "video/mp4",
  m4v: "video/mp4",
  mov: "video/quicktime",
  mkv: "video/x-matroska",
  webm: "video/webm",
  ogg: "video/ogg",
  ogv: "video/ogg",
  ts: "video/mp2t",
  mts: "video/mp2t",
  m2ts: "video/mp2t",
};

export const VIDEO_FILE_ACCEPT =
  ".mp4,.m4v,.mov,.mkv,.webm,.ogg,.ogv,.ts,.mts,.m2ts,video/*";

export type PreparedVideo = {
  source: Blob;
  duration: number;
  normalized: boolean;
  cleanup: () => Promise<void>;
};

function extensionOf(name: string) {
  return name.split(".").pop()?.toLowerCase() || "";
}

/**
 * File.type is frequently empty for MKV and transport-stream files. Giving the
 * blob an accurate media type lets browsers that do support the container play
 * it directly, without doing any conversion.
 */
function withUsefulVideoType(file: File) {
  if (file.type.startsWith("video/")) return file;
  const inferred = MIME_BY_EXTENSION[extensionOf(file.name)];
  return inferred ? file.slice(0, file.size, inferred) : file;
}

function probeNativePlayback(source: Blob) {
  return new Promise<number>((resolve, reject) => {
    const video = document.createElement("video");
    const url = URL.createObjectURL(source);
    let settled = false;

    const finish = (duration?: number, error?: Error) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      video.removeAttribute("src");
      video.load();
      URL.revokeObjectURL(url);
      if (error) reject(error);
      else resolve(duration || 0);
    };

    // loadedmetadata only proves that the container header was readable.
    // loadeddata proves that the browser decoded an actual video frame.
    video.preload = "auto";
    video.onloadedmetadata = () => {
      if (!video.videoWidth || !video.videoHeight) {
        finish(undefined, new Error("The selected file has no playable video track"));
      }
    };
    video.onloadeddata = () => {
      if (!video.videoWidth || !video.videoHeight) return;
      finish(video.duration);
    };
    video.onerror = () =>
      finish(undefined, new Error("This browser cannot open the source container directly"));
    const timeout = window.setTimeout(
      () => finish(undefined, new Error("Timed out while reading the video")),
      15_000,
    );
    video.src = url;
  });
}

function conversionFailure(reasons: string[]) {
  if (reasons.includes("undecodable_source_codec")) {
    return new Error(
      "This file uses a video or audio codec that this browser cannot decode locally",
    );
  }
  if (reasons.includes("no_encodable_target_codec")) {
    return new Error(
      "This browser cannot create the compatibility stream needed for this file",
    );
  }
  if (reasons.includes("unknown_source_codec")) {
    return new Error("The file contains an unsupported video or audio codec");
  }
  return new Error("This video could not be converted into a browser-compatible stream");
}

/**
 * Converts a browser-incompatible container on the host device. The preferred
 * target is an origin-private temporary file so large movies do not need a
 * second full-size in-memory copy. BufferTarget is a fallback for browsers
 * without OPFS.
 */
async function normalizeLocally(
  file: File,
  onProgress: (progress: number) => void,
): Promise<PreparedVideo> {
  const {
    ALL_FORMATS,
    BlobSource,
    BufferTarget,
    Conversion,
    Input,
    Mp4OutputFormat,
    Output,
    StreamTarget,
  } = await import("mediabunny");

  const input = new Input({
    formats: ALL_FORMATS,
    source: new BlobSource(file),
  });

  let directory: FileSystemDirectoryHandle | null = null;
  let temporaryName = "";

  const removeTemporaryFile = async () => {
    if (!directory || !temporaryName) return;
    await directory.removeEntry(temporaryName).catch(() => undefined);
  };

  try {
    if (!(await input.canRead())) {
      throw new Error(
        "Unsupported video container. Try MP4, MKV, WebM, MOV, Ogg, or MPEG-TS",
      );
    }

    const [videoTrack, audioTrack] = await Promise.all([
      input.getPrimaryVideoTrack(),
      input.getPrimaryAudioTrack(),
    ]);
    if (!videoTrack) throw new Error("The selected file has no video track");

    const duration =
      (await input.getDurationFromMetadata(
        audioTrack ? [videoTrack, audioTrack] : [videoTrack],
      )) ||
      (await input.computeDuration(audioTrack ? [videoTrack, audioTrack] : [videoTrack]));

    let target:
      | InstanceType<typeof BufferTarget>
      | InstanceType<typeof StreamTarget>
      | null = null;
    let readOutput: (() => Promise<Blob>) | null = null;

    if (navigator.storage?.getDirectory) {
      try {
        directory = await navigator.storage.getDirectory();
        temporaryName = `relay-${crypto.randomUUID()}.mp4`;
        const handle = await directory.getFileHandle(temporaryName, { create: true });
        const writable = await handle.createWritable();
        target = new StreamTarget(
          writable as unknown as ConstructorParameters<typeof StreamTarget>[0],
          { chunked: true, chunkSize: 2 ** 22 },
        );
        readOutput = () => handle.getFile();
      } catch {
        await removeTemporaryFile();
        directory = null;
        temporaryName = "";
      }
    }

    if (!target || !readOutput) {
      const bufferTarget = new BufferTarget();
      target = bufferTarget;
      readOutput = async () => {
        if (!bufferTarget.buffer) throw new Error("The local conversion produced no file");
        return new Blob([bufferTarget.buffer], { type: "video/mp4" });
      };
    }

    const output = new Output({
      // With a seekable OPFS target this avoids holding all packets in memory.
      // BufferTarget still automatically creates a fast-start file.
      format: new Mp4OutputFormat({
        fastStart: target instanceof BufferTarget ? "in-memory" : false,
      }),
      target,
    });
    const conversion = await Conversion.init({
      input,
      output,
      tracks: "primary",
      video: { codec: "avc" },
      audio: { codec: "aac" },
      showWarnings: false,
    });

    const reasons = conversion.discardedTracks.map((item) => item.reason);
    const includesVideo = conversion.utilizedTracks.some((track) => track.isVideoTrack());
    const includesAudio =
      !audioTrack || conversion.utilizedTracks.some((track) => track.isAudioTrack());
    if (!conversion.isValid || !includesVideo || !includesAudio) {
      throw conversionFailure(reasons);
    }

    conversion.onProgress = (progress) => onProgress(Math.max(0, Math.min(1, progress)));
    onProgress(0);
    await conversion.execute();
    onProgress(1);

    const rawOutput = await readOutput();
    const source = rawOutput.slice(0, rawOutput.size, "video/mp4");
    const playableDuration = await probeNativePlayback(source);
    return {
      source,
      duration: playableDuration || duration,
      normalized: true,
      cleanup: removeTemporaryFile,
    };
  } catch (error) {
    await removeTemporaryFile();
    throw error;
  } finally {
    input.dispose();
  }
}

export async function preparePlayableVideo(
  file: File,
  onProgress: (progress: number) => void = () => undefined,
): Promise<PreparedVideo> {
  const directSource = withUsefulVideoType(file);
  try {
    return {
      source: directSource,
      duration: await probeNativePlayback(directSource),
      normalized: false,
      cleanup: async () => undefined,
    };
  } catch {
    return normalizeLocally(file, onProgress);
  }
}
