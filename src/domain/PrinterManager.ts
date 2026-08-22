import { PrinterService } from './PrinterService.js';

export class PrinterManager {
  private printers: Map<string, PrinterService> = new Map();
  private defaultSerial: string | null = null;

  public registerPrinter(serial: string, service: PrinterService): void {
    this.printers.set(serial, service);
    if (!this.defaultSerial) {
      this.defaultSerial = serial;
    }
  }

  public getPrinter(serial?: string): PrinterService | undefined {
    if (!serial || serial === 'default') {
      if (this.defaultSerial) {
        return this.printers.get(this.defaultSerial);
      }
      // Return first printer if any
      const first = this.printers.values().next();
      return first.done ? undefined : first.value;
    }
    return this.printers.get(serial);
  }

  public getAllPrinters(): PrinterService[] {
    return Array.from(this.printers.values());
  }

  public setDefaultSerial(serial: string): void {
    this.defaultSerial = serial;
  }

  public getDefaultSerial(): string | null {
    return this.defaultSerial;
  }
}
