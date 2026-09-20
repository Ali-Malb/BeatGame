/**
 * DashboardDisplay — the instrument cluster physically mounted behind the
 * windscreen. Rendered to a CanvasTexture at 30 Hz: 0–16 000 RPM arc with LED
 * sweep + flashing 14 200 shift light, digital speedometer, gear indicator.
 */

import * as THREE from 'three';
import { makeCanvas, clamp } from '../core/utils';
import { SHIFT_LIGHT } from './BikePhysicsModel';

export class DashboardDisplay {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  texture: THREE.CanvasTexture;
  private bg: HTMLCanvasElement;
  private redrawTimer = 0;
  private flashPhase = 0;

  // smoothed values for needle inertia
  private needleRpm = 0;

  constructor() {
    const { canvas, ctx } = makeCanvas(512, 256);
    this.canvas = canvas;
    this.ctx = ctx;
    this.texture = new THREE.CanvasTexture(canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.bg = this.buildBackground();
  }

  private buildBackground(): HTMLCanvasElement {
    const { canvas, ctx } = makeCanvas(512, 256);
    // panel
    ctx.fillStyle = '#0b0d10';
    ctx.beginPath();
    ctx.roundRect(4, 4, 504, 248, 18);
    ctx.fill();
    ctx.strokeStyle = '#23262c';
    ctx.lineWidth = 3;
    ctx.stroke();

    // tach arc: center left
    const cx = 150;
    const cy = 148;
    const r = 96;
    const a0 = Math.PI * 0.75;
    const a1 = Math.PI * 2.25;
    // track
    ctx.strokeStyle = '#1a2027';
    ctx.lineWidth = 13;
    ctx.beginPath();
    ctx.arc(cx, cy, r, a0, a1);
    ctx.stroke();
    // redline zone (14.2k+)
    const redA = a0 + ((a1 - a0) * SHIFT_LIGHT) / 16000;
    ctx.strokeStyle = '#c1182a';
    ctx.beginPath();
    ctx.arc(cx, cy, r, redA, a1);
    ctx.stroke();
    // ticks every 1000
    for (let rpm = 0; rpm <= 16000; rpm += 1000) {
      const a = a0 + ((a1 - a0) * rpm) / 16000;
      const major = rpm % 2000 === 0;
      const len = major ? 16 : 9;
      ctx.strokeStyle = rpm >= SHIFT_LIGHT ? '#e0404c' : '#9aa4ae';
      ctx.lineWidth = major ? 3 : 2;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * (r - 7), cy + Math.sin(a) * (r - 7));
      ctx.lineTo(cx + Math.cos(a) * (r - 7 - len), cy + Math.sin(a) * (r - 7 - len));
      ctx.stroke();
      if (major) {
        ctx.fillStyle = rpm >= SHIFT_LIGHT ? '#e0404c' : '#b8c0c8';
        ctx.font = 'bold 17px monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(rpm / 1000), cx + Math.cos(a) * (r - 34), cy + Math.sin(a) * (r - 34));
      }
    }
    ctx.fillStyle = '#7d8791';
    ctx.font = '13px monospace';
    ctx.fillText('x1000 rpm', cx, cy + 34);

    // LCD speedo frame (right side)
    ctx.strokeStyle = '#2b3138';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.roundRect(292, 52, 196, 92, 10);
    ctx.stroke();
    ctx.fillStyle = '#0d1512';
    ctx.fillRect(296, 56, 188, 84);
    ctx.fillStyle = '#39524a';
    ctx.font = '15px monospace';
    ctx.textAlign = 'left';
    ctx.fillText('km/h', 304, 74);

    // gear box
    ctx.strokeStyle = '#2b3138';
    ctx.beginPath();
    ctx.roundRect(292, 158, 92, 78, 10);
    ctx.stroke();
    ctx.fillStyle = '#101418';
    ctx.fillRect(296, 162, 84, 70);
    ctx.fillStyle = '#7d8791';
    ctx.font = '13px monospace';
    ctx.fillText('GEAR', 306, 178);

    // shift light strip top
    ctx.fillStyle = '#15181c';
    ctx.beginPath();
    ctx.roundRect(398, 166, 88, 22, 6);
    ctx.fill();

    // combo strip bottom right
    ctx.fillStyle = '#15181c';
    ctx.fillRect(398, 196, 88, 34);
    ctx.fillStyle = '#5b6570';
    ctx.font = '11px monospace';
    ctx.fillText('SHIFT', 424, 210);
    return canvas;
  }

  /** call every frame; internally throttled to ~30 Hz */
  update(dt: number, rpm: number, speedKmh: number, gear: number, combo: number, shiftNow: boolean) {
    this.redrawTimer += dt;
    if (this.redrawTimer < 1 / 30) return;
    this.redrawTimer = 0;
    this.needleRpm += (rpm - this.needleRpm) * 0.55;
    this.flashPhase += dt * 14;

    const ctx = this.ctx;
    ctx.clearRect(0, 0, 512, 256);
    ctx.drawImage(this.bg, 0, 0);

    // ---- LED sweep along the arc ----
    const cx = 150;
    const cy = 148;
    const r = 96;
    const a0 = Math.PI * 0.75;
    const a1 = Math.PI * 2.25;
    const leds = 16;
    const rpmFrac = clamp(this.needleRpm / 16000, 0, 1);
    const flashOn = shiftNow && Math.sin(this.flashPhase) > 0;
    for (let i = 0; i < leds; i++) {
      const f = (i + 1) / leds;
      const a = a0 + (a1 - a0) * f;
      const lit = f <= rpmFrac || (shiftNow && f > 0.86 && flashOn);
      const col = f > 0.9 ? '#ff3040' : f > 0.72 ? '#ffb020' : '#22e06a';
      ctx.fillStyle = lit ? col : '#22262b';
      ctx.beginPath();
      ctx.arc(cx + Math.cos(a) * (r + 13), cy + Math.sin(a) * (r + 13), 4.2, 0, Math.PI * 2);
      ctx.fill();
    }

    // ---- needle ----
    const na = a0 + (a1 - a0) * clamp(this.needleRpm / 16000, 0, 1.02);
    ctx.strokeStyle = '#f2f4f6';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(cx - Math.cos(na) * 14, cy - Math.sin(na) * 14);
    ctx.lineTo(cx + Math.cos(na) * (r - 4), cy + Math.sin(na) * (r - 4));
    ctx.stroke();
    ctx.fillStyle = '#c9ced3';
    ctx.beginPath();
    ctx.arc(cx, cy, 7, 0, Math.PI * 2);
    ctx.fill();

    // ---- speed LCD ----
    ctx.fillStyle = '#e8fff0';
    ctx.font = 'bold 56px monospace';
    ctx.textAlign = 'right';
    ctx.fillText(String(Math.round(speedKmh)).padStart(3, ' '), 474, 130);

    // ---- gear ----
    ctx.fillStyle = gear === 0 ? '#8fd0a0' : '#d8ffe6';
    ctx.font = 'bold 44px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(gear === 0 ? 'N' : String(gear), 338, 216);

    // ---- shift light strip ----
    if (shiftNow && flashOn) {
      ctx.fillStyle = '#ff2233';
      ctx.beginPath();
      ctx.roundRect(400, 168, 84, 18, 5);
      ctx.fill();
    }

    // ---- combo multiplier bar ----
    if (combo > 1.01) {
      ctx.fillStyle = '#ffb020';
      ctx.font = 'bold 16px monospace';
      ctx.textAlign = 'center';
      ctx.fillText(`x${combo.toFixed(1)}`, 442, 222);
      ctx.fillStyle = '#3a3f46';
      ctx.fillRect(402, 226, 80, 5);
      ctx.fillStyle = '#ffb020';
      ctx.fillRect(402, 226, 80 * clamp((combo - 1) / 9, 0, 1), 5);
    }

    this.texture.needsUpdate = true;
  }

  dispose() {
    this.texture.dispose();
  }
}
