import * as VOXELIZE from "@voxelize/core";
import { Vector3 } from "three";

import { RhythmChart, RhythmNote } from "./osu-parser";

export type RhythmCourseMode = "platform" | "rail";

export type NotePlacement = {
  index: number;
  note: RhythmNote;
  laneIndex: number;
  laneX: number;
  startZ: number;
  endZ: number;
  /** Feet height the runner should align to when contacting the surface. */
  contactFeetY: number;
  /** Additional offset applied to create a jump arc for short notes. */
  jumpHeight: number;
  /** Specific handling for this note in its mode. */
  behaviour: "jump" | "run" | "rail-left" | "rail-right";
  /** Primary voxel position associated with this note for highlighting/clearing. */
  voxelPosition: VOXELIZE.Coords3;
};

export type RhythmCourse = {
  mode: RhythmCourseMode;
  origin: Vector3;
  baseVoxel: VOXELIZE.Coords3;
  moveSpeed: number;
  laneSpacing: number;
  placements: NotePlacement[];
  blockPlacements: VOXELIZE.BlockUpdate[];
  duration: number;
};

type BuilderBlockNames = {
  platform: string;
  jump: string;
  railLeft: string;
  railRight: string;
  railTrack: string;
};

type BuilderOptions = {
  baseVoxel: VOXELIZE.Coords3;
  moveSpeed?: number;
  laneSpacing?: number;
  jumpHeight?: number;
  blockNames?: Partial<BuilderBlockNames>;
};

const DEFAULT_BLOCKS: BuilderBlockNames = {
  platform: "White Concrete",
  jump: "Yellow Concrete",
  railLeft: "Blue Concrete",
  railRight: "Red Concrete",
  railTrack: "Black Concrete",
};

function voxelToWorld(vx: number, vy: number, vz: number) {
  return new Vector3(vx + 0.5, vy + 0.5, vz + 0.5);
}

function roundToVoxel(value: number) {
  return Math.round(value);
}

export class RhythmCourseBuilder {
  private readonly moveSpeed: number;
  private readonly laneSpacing: number;
  private readonly jumpHeight: number;
  private readonly blockNames: BuilderBlockNames;
  private readonly origin: Vector3;

  private platformBlockId = 0;
  private jumpBlockId = 0;
  private railLeftBlockId = 0;
  private railRightBlockId = 0;
  private railTrackBlockId = 0;

  constructor(
    private readonly world: VOXELIZE.World,
    private readonly options: BuilderOptions
  ) {
    this.moveSpeed = options.moveSpeed ?? 6;
    this.laneSpacing = options.laneSpacing ?? 2;
    this.jumpHeight = options.jumpHeight ?? 1.25;
    this.blockNames = {
      ...DEFAULT_BLOCKS,
      ...(options.blockNames || {}),
    };

    const [vx, vy, vz] = options.baseVoxel;
    this.origin = voxelToWorld(vx, vy, vz);

    this.resolveBlockIds();
  }

  private resolveBlockIds() {
    const platform = this.world.getBlockByName(this.blockNames.platform);
    const jump = this.world.getBlockByName(this.blockNames.jump);
    const left = this.world.getBlockByName(this.blockNames.railLeft);
    const right = this.world.getBlockByName(this.blockNames.railRight);
    const track = this.world.getBlockByName(this.blockNames.railTrack);

    if (!platform || !jump || !left || !right || !track) {
      throw new Error(
        "RhythmCourseBuilder: Missing required block definitions in world."
      );
    }

    this.platformBlockId = platform.id;
    this.jumpBlockId = jump.id;
    this.railLeftBlockId = left.id;
    this.railRightBlockId = right.id;
    this.railTrackBlockId = track.id;
  }

  buildPlatformCourse(chart: RhythmChart): RhythmCourse {
    const placements: NotePlacement[] = [];
    const blockPlacements: VOXELIZE.BlockUpdate[] = [];

    const baseVoxel = this.options.baseVoxel;
    const baseHeight = baseVoxel[1];
    const playerFeetY = baseHeight + 1; // player feet touch top of block at baseHeight + 1

    chart.notes.forEach((note, index) => {
      const startZ = this.origin.z + note.time * this.moveSpeed;
      const endZ = this.origin.z + note.endTime * this.moveSpeed;

      const voxelZStart = roundToVoxel(startZ - 0.5);
      const voxelZEnd = roundToVoxel(endZ - 0.5);

      if (note.type === "long") {
        for (let z = Math.min(voxelZStart, voxelZEnd); z <= Math.max(voxelZStart, voxelZEnd); z++) {
          blockPlacements.push({
            vx: baseVoxel[0],
            vy: baseHeight,
            vz: z,
            type: this.platformBlockId,
          });
        }
      } else {
        blockPlacements.push({
          vx: baseVoxel[0],
          vy: baseHeight + 1,
          vz: voxelZStart,
          type: this.jumpBlockId,
        });
        blockPlacements.push({
          vx: baseVoxel[0],
          vy: baseHeight,
          vz: voxelZStart,
          type: this.platformBlockId,
        });
      }

      placements.push({
        index,
        note,
        laneIndex: note.lane,
        laneX: this.origin.x,
        startZ,
        endZ,
        contactFeetY: playerFeetY,
        jumpHeight: note.type === "short" ? this.jumpHeight : 0,
        behaviour: note.type === "short" ? "jump" : "run",
        voxelPosition: [
          baseVoxel[0],
          note.type === "short" ? baseHeight + 1 : baseHeight,
          voxelZStart,
        ],
      });

      // Add small bridging platform between short notes to avoid void gaps
      const nextNote = chart.notes[index + 1];
      if (nextNote) {
        const nextStartZ = this.origin.z + nextNote.time * this.moveSpeed;
        const gap = nextStartZ - endZ;
        if (gap > 1.2) {
          const fillerCount = Math.floor(gap - 0.5);
          for (let i = 1; i <= fillerCount; i++) {
            const z = roundToVoxel(endZ - 0.5 + i);
            blockPlacements.push({
              vx: baseVoxel[0],
              vy: baseHeight - 1,
              vz: z,
              type: this.platformBlockId,
            });
          }
        }
      }
    });

    return {
      mode: "platform",
      origin: this.origin.clone(),
      baseVoxel: [...baseVoxel],
      moveSpeed: this.moveSpeed,
      laneSpacing: this.laneSpacing,
      placements,
      blockPlacements,
      duration: chart.totalDuration,
    };
  }

  buildRailCourse(chart: RhythmChart): RhythmCourse {
    const placements: NotePlacement[] = [];
    const blockPlacements: VOXELIZE.BlockUpdate[] = [];

    const baseVoxel = this.options.baseVoxel;
    const baseHeight = baseVoxel[1];
    const contactFeetY = baseHeight + 2;
    const leftX = this.origin.x - this.laneSpacing;
    const rightX = this.origin.x + this.laneSpacing;

    const leftVoxelX = roundToVoxel(leftX - 0.5);
    const rightVoxelX = roundToVoxel(rightX - 0.5);

    const railY = baseHeight;

    // Build central rail track for the vehicle/player
    const totalLength = chart.totalDuration * this.moveSpeed + 10;
    const startZ = roundToVoxel(this.origin.z - 0.5);
    const endZ = roundToVoxel(this.origin.z - 0.5 + totalLength);

    for (let z = startZ; z <= endZ; z++) {
      blockPlacements.push({
        vx: baseVoxel[0],
        vy: railY,
        vz: z,
        type: this.railTrackBlockId,
      });
    }

    chart.notes.forEach((note, index) => {
      const noteZ = this.origin.z + note.time * this.moveSpeed;
      const voxelZ = roundToVoxel(noteZ - 0.5);
      const isLeft = note.lane < chart.keyCount / 2;

      const vx = isLeft ? leftVoxelX : rightVoxelX;
      const blockType = isLeft ? this.railLeftBlockId : this.railRightBlockId;

      blockPlacements.push({
        vx,
        vy: railY + 1,
        vz: voxelZ,
        type: blockType,
      });

      placements.push({
        index,
        note,
        laneIndex: note.lane,
        laneX: isLeft ? leftX : rightX,
        startZ: noteZ,
        endZ: noteZ,
        contactFeetY,
        jumpHeight: 0,
        behaviour: isLeft ? "rail-left" : "rail-right",
        voxelPosition: [vx, railY + 1, voxelZ],
      });
    });

    return {
      mode: "rail",
      origin: this.origin.clone(),
      baseVoxel: [...baseVoxel],
      moveSpeed: this.moveSpeed,
      laneSpacing: this.laneSpacing,
      placements,
      blockPlacements,
      duration: chart.totalDuration,
    };
  }
}
