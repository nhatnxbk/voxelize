export type RhythmNote = {
  /** Time in seconds relative to song start. */
  time: number;
  /** End time in seconds (equals `time` for short notes). */
  endTime: number;
  /** Duration in seconds (0 for short notes). */
  duration: number;
  /** Column index within the chart, starting at 0 on the left. */
  lane: number;
  /** Whether this is a hold note. */
  type: "short" | "long";
};

export type RhythmTimingPoint = {
  /** Time in seconds the timing point becomes active. */
  time: number;
  /** Beats per minute for this timing segment. */
  bpm: number;
  /** Meter / beat division information. */
  meter: number;
};

export type RhythmChart = {
  title: string;
  artist: string;
  creator: string;
  version: string;
  audioFilename: string;
  keyCount: number;
  notes: RhythmNote[];
  timingPoints: RhythmTimingPoint[];
  totalDuration: number;
};

const SECTION_REGEX = /^\s*\[(.+)]\s*$/;

function splitSections(content: string) {
  const sections: Record<string, string[]> = {};
  let current = "";

  content.split(/\r?\n/).forEach((line) => {
    const match = line.match(SECTION_REGEX);
    if (match) {
      current = match[1];
      sections[current] = [];
      return;
    }

    if (!current) return;
    sections[current].push(line);
  });

  return sections;
}

function parseKeyValueBlock(lines: string[]) {
  const map: Record<string, string> = {};

  lines.forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("//")) return;
    const [key, ...rest] = trimmed.split(":");
    if (!key || rest.length === 0) return;
    map[key.trim()] = rest.join(":").trim();
  });

  return map;
}

function safeNumber(value: string | undefined, fallback: number) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseTimingPoints(lines: string[]): RhythmTimingPoint[] {
  const points: RhythmTimingPoint[] = [];

  lines.forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("//")) return;

    const parts = trimmed.split(",");
    if (parts.length < 2) return;

    const timeMs = Number(parts[0]);
    const beatLength = Number(parts[1]);
    const meter = parts.length > 2 ? Number(parts[2]) : 4;

    if (!Number.isFinite(timeMs) || !Number.isFinite(beatLength)) return;

    if (beatLength < 0) {
      // Negative beatLength indicates an inherited timing point (slider velocity change).
      // We do not need it for coarse rhythm syncing, so ignore.
      return;
    }

    const bpm = beatLength !== 0 ? 60000 / beatLength : 0;
    points.push({
      time: timeMs / 1000,
      bpm,
      meter: Number.isFinite(meter) ? meter : 4,
    });
  });

  // Ensure points sorted by time
  points.sort((a, b) => a.time - b.time);

  return points;
}

function parseHitObjects(lines: string[], keyCount: number): RhythmNote[] {
  const notes: RhythmNote[] = [];
  const lanes = keyCount > 0 ? keyCount : 4;

  const laneWidth = 512 / lanes;

  lines.forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("//")) return;

    const parts = trimmed.split(",");
    if (parts.length < 5) return;

    const x = Number(parts[0]);
    const timeMs = Number(parts[2]);
    const type = Number(parts[3]);

    if (!Number.isFinite(x) || !Number.isFinite(timeMs) || !Number.isFinite(type))
      return;

    const isHold = (type & 128) === 128;
    let endTimeMs = timeMs;

    if (isHold && parts.length > 5) {
      const [endStr] = parts[5].split(":");
      const parsedEnd = Number(endStr);
      if (Number.isFinite(parsedEnd)) {
        endTimeMs = parsedEnd;
      }
    }

    const lane = Math.min(lanes - 1, Math.max(0, Math.floor(x / laneWidth)));
    const time = timeMs / 1000;
    const endTime = Math.max(time, endTimeMs / 1000);

    notes.push({
      time,
      endTime,
      duration: Math.max(0, endTime - time),
      lane,
      type: endTime > time ? "long" : "short",
    });
  });

  notes.sort((a, b) => a.time - b.time);

  return notes;
}

export function getBpmAtTime(points: RhythmTimingPoint[], time: number) {
  if (!points.length) return 0;
  let current = points[0];
  for (let i = 0; i < points.length; i++) {
    const point = points[i];
    if (point.time <= time) {
      current = point;
    } else {
      break;
    }
  }
  return current.bpm;
}

export function parseOsuFile(content: string): RhythmChart {
  const sections = splitSections(content);

  const metadata = parseKeyValueBlock(sections.Metadata || []);
  const general = parseKeyValueBlock(sections.General || []);
  const difficulty = parseKeyValueBlock(sections.Difficulty || []);
  const timingPoints = parseTimingPoints(sections.TimingPoints || []);

  const keyCount = safeNumber(difficulty.CircleSize, 4);
  const notes = parseHitObjects(sections.HitObjects || [], keyCount);

  const totalDuration = notes.length
    ? notes.reduce((max, note) => Math.max(max, note.endTime), 0)
    : 0;

  return {
    title: metadata.Title || "Unknown Title",
    artist: metadata.Artist || "Unknown Artist",
    creator: metadata.Creator || "Unknown Mapper",
    version: metadata.Version || "",
    audioFilename: general.AudioFilename || "",
    keyCount,
    notes,
    timingPoints,
    totalDuration,
  };
}
