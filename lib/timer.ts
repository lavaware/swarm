interface EMAConfig {
  alpha: number;
  ema: number;
  startTime: number;
  totalItems: number;
  itemsProcessed: number;
}

export class Timer {
  config: EMAConfig;

  constructor(config: EMAConfig) {
    this.config = config;
  }

  tick(startTime: number, scaleFactor = 1) {
    this.config.itemsProcessed++;

    const itemElapsedTime = Date.now() - startTime;

    this.config.ema
      = this.config.ema === 0
        ? itemElapsedTime
        : this.config.alpha * itemElapsedTime + (1 - this.config.alpha) * this.config.ema;

    // Estimate remaining time.
    const remainingItems = this.config.totalItems - this.config.itemsProcessed;
    const eta = (this.config.ema * remainingItems) / scaleFactor; // scaleFactor represents the number of proxies running simultaneously.
    const elapsed = Date.now() - this.config.startTime;
    const etaDisplay = this.formatETA(eta);
    const elapsedDisplay = new Date(elapsed).toISOString().slice(11, 19);
    const remainingDisplay
      = `${this.config.itemsProcessed.toString().padStart(this.config.totalItems.toString().length, " ")}`
        + `/${this.config.totalItems}`;

    return { elapsed: elapsedDisplay, eta: etaDisplay, remaining: remainingDisplay };
  }

  formatETA(time: number) {
    let delta = Math.abs(time) / 1000;

    const days = Math.floor(delta / 86400);
    delta -= days * 86400;

    const hours = Math.floor(delta / 3600) % 24;
    delta -= hours * 3600;

    const minutes = Math.floor(delta / 60) % 60;
    delta -= minutes * 60;

    const seconds = Math.round(delta % 60);

    return [
      days.toString().padStart(3, "0"),
      hours.toString().padStart(2, "0"),
      minutes.toString().padStart(2, "0"),
      seconds.toString().padStart(2, "0"),
    ].join(":");
  }
}
