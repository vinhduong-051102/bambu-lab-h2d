export class BambuTopics {
  public static getReportTopic(serial: string): string {
    return `device/${serial}/report`;
  }

  public static getRequestTopic(serial: string): string {
    return `device/${serial}/request`;
  }
}
