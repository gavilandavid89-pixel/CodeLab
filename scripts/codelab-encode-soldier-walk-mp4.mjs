import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

export const SOLDIER_WALK = Object.freeze({ frameCount: 20, fps: 12, width: 128, height: 160 });

export function expectedFrameNames(frameCount = SOLDIER_WALK.frameCount) {
  return Array.from({ length: frameCount }, (_, index) => `frame-${String(index).padStart(3, '0')}.png`);
}

export function validateFrameNames(names, frameCount = SOLDIER_WALK.frameCount) {
  const expected = expectedFrameNames(frameCount);
  const actual = [...names].sort();
  if (actual.length !== expected.length || expected.some((name, index) => actual[index] !== name)) {
    throw new Error(`Expected exactly ${frameCount} numbered PNG frames; found ${actual.length}.`);
  }
  return expected;
}

export function validateProbe(probe, { frameCount = SOLDIER_WALK.frameCount, fps = SOLDIER_WALK.fps } = {}) {
  const stream = probe?.streams?.find(item => item.codec_type === 'video');
  if (!stream || stream.codec_name !== 'h264') throw new Error('MP4 does not contain an H.264 video stream.');
  const actualFrames = Number(stream.nb_frames ?? probe?.format?.tags?.NUMBER_OF_FRAMES);
  if (actualFrames !== frameCount) throw new Error(`MP4 frame count mismatch: expected ${frameCount}, got ${actualFrames || 'unknown'}.`);
  const rate = String(stream.avg_frame_rate || stream.r_frame_rate || '');
  const [numerator, denominator] = rate.split('/').map(Number);
  if (!numerator || !denominator || Math.abs(numerator / denominator - fps) > 0.001) {
    throw new Error(`MP4 FPS mismatch: expected ${fps}, got ${rate || 'unknown'}.`);
  }
  const duration = Number(probe?.format?.duration);
  const expectedDuration = frameCount / fps;
  if (!Number.isFinite(duration) || Math.abs(duration - expectedDuration) > 0.08) {
    throw new Error(`MP4 duration mismatch: expected ${expectedDuration.toFixed(3)}s, got ${probe?.format?.duration || 'unknown'}.`);
  }
  return { codec: stream.codec_name, frames: actualFrames, fps: numerator / denominator, duration };
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => stdout += chunk);
    child.stderr.on('data', chunk => stderr += chunk);
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`${command} exited ${code}: ${stderr.slice(-4000)}`)));
  });
}

export async function encodeSoldierWalk({ framesDir, outputPath, frameCount = SOLDIER_WALK.frameCount, fps = SOLDIER_WALK.fps }) {
  if (!framesDir || !outputPath) throw new Error('framesDir and outputPath are required.');
  const entries = await fs.readdir(framesDir);
  const frames = validateFrameNames(entries.filter(name => /^frame-\\d{3}\\.png$/.test(name)), frameCount);
  for (const name of frames) {
    const stat = await fs.stat(path.join(framesDir, name));
    if (!stat.isFile() || stat.size < 64) throw new Error(`Invalid or empty frame: ${name}`);
  }
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await run('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-framerate', String(fps),
    '-start_number', '0',
    '-i', path.join(framesDir, 'frame-%03d.png'),
    '-frames:v', String(frameCount),
    '-an', '-c:v', 'libx264', '-preset', 'medium', '-crf', '18',
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
    outputPath
  ]);
  const { stdout } = await run('ffprobe', [
    '-v', 'error', '-count_frames', '-select_streams', 'v:0',
    '-show_entries', 'stream=codec_name,avg_frame_rate,r_frame_rate,nb_frames,nb_read_frames:format=duration',
    '-of', 'json', outputPath
  ]);
  const parsed = JSON.parse(stdout);
  const video = parsed.streams?.[0];
  if (video && !video.nb_frames && video.nb_read_frames) video.nb_frames = video.nb_read_frames;
  const verification = validateProbe(parsed, { frameCount, fps });
  const output = await fs.stat(outputPath);
  if (!output.isFile() || output.size < 1024) throw new Error('Encoded MP4 is missing or unexpectedly small.');
  return { outputPath, bytes: output.size, ...verification };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const framesDir = process.env.CODELAB_VIDEO_FRAMES_DIR || '';
  const outputPath = process.env.CODELAB_VIDEO_OUTPUT || 'artifacts/soldier-walk.mp4';
  const result = await encodeSoldierWalk({ framesDir, outputPath });
  console.log(JSON.stringify({ ok: true, project: 'soldier-walk-60f-20261124', ...result }));
}
