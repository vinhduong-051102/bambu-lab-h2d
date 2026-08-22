import { PrinterCapability } from './PrinterCapability.js';

export class CapabilityRegistry {
  private capabilities: Map<string, PrinterCapability> = new Map();

  constructor() {
    this.registerDefaultCapabilities();
  }

  private registerDefaultCapabilities(): void {
    const defaults: PrinterCapability[] = [
      // Status & Telemetry
      {
        id: 'printer.status',
        name: 'Trạng thái máy in',
        category: 'status',
        read: true,
        write: false,
        status: 'SUPPORTED',
        description: 'Đọc trạng thái realtime, kết nối online/offline và tiến độ',
      },
      {
        id: 'system.info',
        name: 'Thông tin hệ thống',
        category: 'system',
        read: true,
        write: false,
        status: 'SUPPORTED',
        description: 'Đọc Model, Serial, Firmware version',
      },
      {
        id: 'printer.errors',
        name: 'Mã lỗi HMS & Error State',
        category: 'status',
        read: true,
        write: false,
        status: 'SUPPORTED',
        description: 'Đọc các mã lỗi HMS báo về từ máy in',
      },

      // Print Job Read & Control
      {
        id: 'print.job',
        name: 'Theo dõi tác vụ in',
        category: 'print',
        read: true,
        write: false,
        status: 'SUPPORTED',
        description: 'Theo dõi tên file, lớp in, phần trăm tiến độ và thời gian',
      },
      {
        id: 'print.pause',
        name: 'Tạm dừng tác vụ in (Pause)',
        category: 'print',
        read: true,
        write: true,
        status: 'SUPPORTED',
        description: 'Gửi lệnh tạm dừng in qua MQTT LAN Protocol (command: pause)',
      },
      {
        id: 'print.resume',
        name: 'Tiếp tục in (Resume)',
        category: 'print',
        read: true,
        write: true,
        status: 'SUPPORTED',
        description: 'Gửi lệnh tiếp tục in qua MQTT LAN Protocol (command: resume)',
      },
      {
        id: 'print.stop',
        name: 'Hủy/Dừng in (Stop/Cancel)',
        category: 'print',
        read: true,
        write: true,
        status: 'SUPPORTED',
        description: 'Gửi lệnh hủy tác vụ in qua MQTT LAN Protocol (command: stop)',
      },
      {
        id: 'print.start',
        name: 'Bắt đầu tác vụ in mới (Start Print)',
        category: 'print',
        read: false,
        write: true,
        status: 'UNKNOWN',
        description: 'Cần xác nhận chính xác cấu trúc project 3MF/SD Card payload trên H2D',
      },

      // Temperature Read & Control
      {
        id: 'temperature.read',
        name: 'Đọc nhiệt độ',
        category: 'temperature',
        read: true,
        write: false,
        status: 'SUPPORTED',
        description: 'Đọc nhiệt độ Hotend, Bed và Chamber',
      },
      {
        id: 'temperature.nozzle',
        name: 'Điều chỉnh nhiệt độ Hotend 1 (Đầu in #1)',
        category: 'temperature',
        read: true,
        write: true,
        status: 'SUPPORTED',
        description: 'Đặt nhiệt độ mục tiêu cho đầu phun thứ nhất (M104 T0 S{target})',
      },
      {
        id: 'temperature.nozzle2',
        name: 'Điều chỉnh nhiệt độ Hotend 2 (Đầu in #2)',
        category: 'temperature',
        read: true,
        write: true,
        status: 'SUPPORTED',
        description: 'Đặt nhiệt độ mục tiêu cho đầu phun thứ hai (M104 T1 S{target})',
      },
      {
        id: 'temperature.bed',
        name: 'Điều chỉnh nhiệt độ Bàn in',
        category: 'temperature',
        read: true,
        write: true,
        status: 'SUPPORTED',
        description: 'Đặt nhiệt độ mục tiêu cho bàn in (M140 S{target})',
      },

      // Fan Read & Control
      {
        id: 'fan.read',
        name: 'Đọc tốc độ quạt',
        category: 'fan',
        read: true,
        write: false,
        status: 'SUPPORTED',
        description: 'Đọc tốc độ Part, Aux và Chamber fans',
      },
      {
        id: 'fan.part',
        name: 'Điều chỉnh quạt mẫu (Part Fan)',
        category: 'fan',
        read: true,
        write: true,
        status: 'SUPPORTED',
        description: 'Điều chỉnh phần trăm tốc độ Part fan (M106 P1)',
      },
      {
        id: 'fan.aux',
        name: 'Điều chỉnh quạt phụ (Aux Fan)',
        category: 'fan',
        read: true,
        write: true,
        status: 'SUPPORTED',
        description: 'Điều chỉnh phần trăm tốc độ Aux fan (M106 P2)',
      },
      {
        id: 'fan.chamber',
        name: 'Điều chỉnh quạt buồng (Chamber Fan)',
        category: 'fan',
        read: true,
        write: true,
        status: 'SUPPORTED',
        description: 'Điều chỉnh phần trăm tốc độ Chamber fan (M106 P3)',
      },

      // AMS
      {
        id: 'ams.read',
        name: 'Đọc hệ thống khay nhựa AMS',
        category: 'ams',
        read: true,
        write: false,
        status: 'SUPPORTED',
        description: 'Đọc thông tin cuộn nhựa, màu sắc, loại nhựa và độ ẩm AMS',
      },
      {
        id: 'ams.control',
        name: 'Điều khiển khay nhựa AMS (Load/Unload)',
        category: 'ams',
        read: false,
        write: true,
        status: 'UNKNOWN',
        description: 'Chưa có protocol thử nghiệm an toàn trên H2D cho lệnh Load/Unload',
      },

      // Camera
      {
        id: 'camera.stream',
        name: 'Xem Camera Live Stream',
        category: 'camera',
        read: true,
        write: false,
        status: 'SUPPORTED',
        description: 'Xem luồng ảnh snapshot & luồng video RTSPS',
      },

      // File Management (FTPS / SD Card)
      {
        id: 'file.list',
        name: 'Liệt kê danh sách file SD Card',
        category: 'file',
        read: true,
        write: false,
        status: 'UNKNOWN',
        description: 'Yêu cầu kết nối giao thức FTPS cổng 990',
      },
      {
        id: 'file.upload',
        name: 'Tải file Gcode/3MF lên máy in',
        category: 'file',
        read: false,
        write: true,
        status: 'UNSUPPORTED',
        description: 'Yêu cầu kết nối FTPS TLS, không thực hiện qua MQTT LAN',
      },
    ];

    for (const cap of defaults) {
      this.capabilities.set(cap.id, cap);
    }
  }

  public getCapability(id: string): PrinterCapability | undefined {
    return this.capabilities.get(id);
  }

  public getAllCapabilities(): PrinterCapability[] {
    return Array.from(this.capabilities.values());
  }

  public isSupported(id: string, writeRequired = false): boolean {
    const cap = this.capabilities.get(id);
    if (!cap) return false;
    if (cap.status !== 'SUPPORTED') return false;
    if (writeRequired && !cap.write) return false;
    return true;
  }

  public registerCapability(capability: PrinterCapability): void {
    this.capabilities.set(capability.id, capability);
  }
}
