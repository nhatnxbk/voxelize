import * as VOXELIZE from "@voxelize/core";

import { RhythmCourseBuilder, RhythmCourseMode } from "./course-builder";
import { parseOsuFile, RhythmChart } from "./osu-parser";
import { RhythmRunner } from "./runner";

const HIT_WINDOW = 0.2; // seconds for rail mode hits

export type RhythmManagerOptions = {
  world: VOXELIZE.World;
  controls: VOXELIZE.RigidControls;
  inputs: VOXELIZE.Inputs<any>;
  uiParent?: HTMLElement;
};

export class RhythmManager {
  private readonly world: VOXELIZE.World;
  private readonly controls: VOXELIZE.RigidControls;
  private readonly inputs: VOXELIZE.Inputs<any>;
  private readonly container: HTMLDivElement;
  private readonly statusElement: HTMLDivElement;
  private readonly scoreElement: HTMLDivElement;
  private readonly audioElement: HTMLAudioElement;
  private readonly runner: RhythmRunner;

  private chart: RhythmChart | null = null;
  private courseMode: RhythmCourseMode = "platform";
  private audioUrl: string | null = null;
  private courseBuilt = false;

  private hitNotes = new Set<number>();
  private missedNotes = new Set<number>();
  private nextRailIndex = 0;
  private combo = 0;
  private bestCombo = 0;

  private buildButton!: HTMLButtonElement;
  private startButton!: HTMLButtonElement;
  private clearButton!: HTMLButtonElement;
  private modeSelect!: HTMLSelectElement;

  constructor({ world, controls, inputs, uiParent }: RhythmManagerOptions) {
    this.world = world;
    this.controls = controls;
    this.inputs = inputs;
    this.runner = new RhythmRunner({ world, controls });
    this.audioElement = new Audio();
    this.audioElement.preload = "auto";
    this.runner.setAudio(this.audioElement);

    this.container = document.createElement("div");
    this.container.className = "rhythm-overlay";

    this.statusElement = document.createElement("div");
    this.statusElement.className = "rhythm-status";

    this.scoreElement = document.createElement("div");
    this.scoreElement.className = "rhythm-score";

    this.buildUI();

    if (uiParent) {
      uiParent.appendChild(this.container);
    } else {
      document.body.appendChild(this.container);
    }

    this.runner.onFinish(() => {
      this.updateStatus("Đã hoàn thành bản nhạc.");
      this.startButton.disabled = false;
    });

    this.inputs.bind("KeyJ", () => this.handleSlash("left"), "in-game");
    this.inputs.bind("KeyL", () => this.handleSlash("right"), "in-game");
  }

  update(deltaTime: number) {
    this.runner.update(deltaTime);
    if (this.courseMode === "rail" && this.runner.courseMode === "rail") {
      this.resolveRailMisses();
    }
  }

  private buildUI() {
    const title = document.createElement("h2");
    title.textContent = "Rhythm Builder";
    this.container.appendChild(title);

    const audioLabel = document.createElement("label");
    audioLabel.className = "rhythm-row";
    audioLabel.textContent = "Audio:";
    const audioInput = document.createElement("input");
    audioInput.type = "file";
    audioInput.accept = "audio/*";
    audioInput.addEventListener("change", (event) => {
      const file = (event.target as HTMLInputElement).files?.[0];
      if (!file) return;
      this.loadAudioFile(file);
    });
    audioLabel.appendChild(audioInput);
    this.container.appendChild(audioLabel);

    const osuLabel = document.createElement("label");
    osuLabel.className = "rhythm-row";
    osuLabel.textContent = "osu! File:";
    const osuInput = document.createElement("input");
    osuInput.type = "file";
    osuInput.accept = ".osu";
    osuInput.addEventListener("change", (event) => {
      const file = (event.target as HTMLInputElement).files?.[0];
      if (!file) return;
      this.loadOsuFile(file);
    });
    osuLabel.appendChild(osuInput);
    this.container.appendChild(osuLabel);

    const modeLabel = document.createElement("label");
    modeLabel.className = "rhythm-row";
    modeLabel.textContent = "Chế độ:";
    this.modeSelect = document.createElement("select");
    const optionPlatform = document.createElement("option");
    optionPlatform.value = "platform";
    optionPlatform.textContent = "Nhảy qua khối";
    const optionRail = document.createElement("option");
    optionRail.value = "rail";
    optionRail.textContent = "Chém note hai bên";
    this.modeSelect.append(optionPlatform, optionRail);
    this.modeSelect.addEventListener("change", () => {
      this.courseMode = this.modeSelect.value as RhythmCourseMode;
      this.updateScoreboard();
    });
    modeLabel.appendChild(this.modeSelect);
    this.container.appendChild(modeLabel);

    const actionsRow = document.createElement("div");
    actionsRow.className = "rhythm-actions";

    this.buildButton = document.createElement("button");
    this.buildButton.textContent = "Xây đường nhạc";
    this.buildButton.disabled = true;
    this.buildButton.addEventListener("click", () => this.buildCourse());

    this.startButton = document.createElement("button");
    this.startButton.textContent = "Bắt đầu";
    this.startButton.disabled = true;
    this.startButton.addEventListener("click", () => this.startRun());

    this.clearButton = document.createElement("button");
    this.clearButton.textContent = "Xoá";
    this.clearButton.disabled = true;
    this.clearButton.addEventListener("click", () => this.clearCourse());

    actionsRow.append(this.buildButton, this.startButton, this.clearButton);
    this.container.appendChild(actionsRow);

    this.container.appendChild(this.statusElement);
    this.container.appendChild(this.scoreElement);

    const hint = document.createElement("p");
    hint.className = "rhythm-hint";
    hint.textContent = "Rail mode: nhấn phím J để chém trái, L để chém phải.";
    this.container.appendChild(hint);

    this.updateStatus("Tải audio và file osu! để bắt đầu.");
    this.updateScoreboard();
  }

  private loadAudioFile(file: File) {
    if (this.audioUrl) URL.revokeObjectURL(this.audioUrl);
    this.audioUrl = URL.createObjectURL(file);
    this.audioElement.src = this.audioUrl;
    this.audioElement.load();

    this.updateStatus(`Đã tải audio: ${file.name}`);
    this.refreshButtons();
  }

  private async loadOsuFile(file: File) {
    try {
      const content = await file.text();
      this.chart = parseOsuFile(content);
      this.updateStatus(`Đã đọc beatmap: ${this.chart.title} - ${this.chart.artist}`);
      this.refreshButtons();
    } catch (error) {
      console.error(error);
      this.updateStatus("Không đọc được file osu.");
    }
  }

  private refreshButtons() {
    const ready = !!this.chart && !!this.audioUrl;
    this.buildButton.disabled = !ready;
    this.startButton.disabled = !this.courseBuilt;
    this.clearButton.disabled = !this.courseBuilt;
  }

  private buildCourse() {
    if (!this.world.isInitialized) {
      this.updateStatus("Thế giới đang khởi tạo, vui lòng đợi.");
      return;
    }

    if (!this.chart) {
      this.updateStatus("Chưa có beatmap.");
      return;
    }

    const [vx, vy, vz] = this.controls.voxel;
    const baseVoxel: VOXELIZE.Coords3 = [
      Math.round(vx + 3),
      Math.max(5, Math.round(vy + 5)),
      Math.round(vz + 5),
    ];

    const builder = new RhythmCourseBuilder(this.world, {
      baseVoxel,
      moveSpeed: this.courseMode === "rail" ? 8 : 6,
      laneSpacing: this.courseMode === "rail" ? 3 : 2,
      jumpHeight: 1.6,
    });

    const course =
      this.courseMode === "rail"
        ? builder.buildRailCourse(this.chart)
        : builder.buildPlatformCourse(this.chart);

    this.runner.applyCourse(course);
    this.courseBuilt = true;
    this.refreshButtons();

    this.hitNotes.clear();
    this.missedNotes.clear();
    this.nextRailIndex = 0;
    this.combo = 0;
    this.bestCombo = 0;
    this.updateScoreboard();

    this.updateStatus(
      `Đã dựng đường nhạc tại (${baseVoxel.join(", ")}). Nhấn "Bắt đầu" để chơi.`
    );
  }

  private startRun() {
    if (!this.courseBuilt) {
      this.updateStatus("Chưa có đường nhạc.");
      return;
    }

    const started = this.runner.start();
    if (!started) {
      this.updateStatus("Không thể phát audio. Hãy kiểm tra quyền phát trong trình duyệt.");
      return;
    }

    this.startButton.disabled = true;
    this.combo = 0;
    this.hitNotes.clear();
    this.missedNotes.clear();
    this.nextRailIndex = 0;
    this.updateScoreboard();
    this.updateStatus("Đang chạy...");
  }

  private clearCourse() {
    this.runner.clearCourse();
    this.courseBuilt = false;
    this.refreshButtons();
    this.updateStatus("Đã xoá đường nhạc.");
  }

  private handleSlash(side: "left" | "right") {
    if (this.runner.courseMode !== "rail") return;
    if (this.runner.runnerState !== "running") return;

    const placements = this.runner
      .getActivePlacements(HIT_WINDOW)
      .filter((placement) =>
        side === "left"
          ? placement.behaviour === "rail-left"
          : placement.behaviour === "rail-right"
      )
      .filter((placement) =>
        !this.hitNotes.has(placement.index) && !this.missedNotes.has(placement.index)
      )
      .sort(
        (a, b) =>
          Math.abs(a.note.time - this.runner.currentAudioTime) -
          Math.abs(b.note.time - this.runner.currentAudioTime)
      );

    const target = placements[0];
    if (!target) {
      this.combo = 0;
      this.updateScoreboard();
      return;
    }

    this.hitNotes.add(target.index);
    this.combo += 1;
    this.bestCombo = Math.max(this.bestCombo, this.combo);
    this.updateScoreboard();

    this.world.updateVoxels([
      {
        vx: target.voxelPosition[0],
        vy: target.voxelPosition[1],
        vz: target.voxelPosition[2],
        type: 0,
      },
    ]);

    this.advanceRailPointer();
  }

  private resolveRailMisses() {
    const course = this.runner.activeCourse;
    if (!course) return;

    const placements = course.placements;
    const now = this.runner.currentAudioTime;

    while (this.nextRailIndex < placements.length) {
      const placement = placements[this.nextRailIndex];
      const actionable =
        placement.behaviour === "rail-left" || placement.behaviour === "rail-right";

      if (!actionable) {
        this.nextRailIndex += 1;
        continue;
      }

      if (this.hitNotes.has(placement.index) || this.missedNotes.has(placement.index)) {
        this.nextRailIndex += 1;
        continue;
      }

      if (placement.note.time + HIT_WINDOW < now) {
        this.missedNotes.add(placement.index);
        this.combo = 0;
        this.world.updateVoxels([
          {
            vx: placement.voxelPosition[0],
            vy: placement.voxelPosition[1],
            vz: placement.voxelPosition[2],
            type: 0,
          },
        ]);
        this.updateScoreboard();
        this.nextRailIndex += 1;
        continue;
      }

      break;
    }
  }

  private advanceRailPointer() {
    const course = this.runner.activeCourse;
    if (!course) return;

    const placements = course.placements;
    while (this.nextRailIndex < placements.length) {
      const placement = placements[this.nextRailIndex];
      if (
        placement.behaviour !== "rail-left" &&
        placement.behaviour !== "rail-right"
      ) {
        this.nextRailIndex += 1;
        continue;
      }
      if (
        this.hitNotes.has(placement.index) ||
        this.missedNotes.has(placement.index)
      ) {
        this.nextRailIndex += 1;
        continue;
      }
      break;
    }
  }

  private updateStatus(message: string) {
    this.statusElement.textContent = message;
  }

  private updateScoreboard() {
    if (this.courseMode === "rail") {
      const hits = this.hitNotes.size;
      const misses = this.missedNotes.size;
      this.scoreElement.textContent = `Combo: ${this.combo} / Best: ${this.bestCombo} | Hit: ${hits} | Miss: ${misses}`;
    } else {
      this.scoreElement.textContent = "Platform mode: bấm \"Bắt đầu\" để tự động chạy.";
    }
  }
}
