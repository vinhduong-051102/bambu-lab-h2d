import mqtt, { MqttClient } from 'mqtt';
import { logger } from '../logger/logger.js';
import { BambuClientOptions } from './types.js';
import { BambuTopics } from './BambuTopics.js';

export type OnMessageCallback = (topic: string, message: Buffer) => void;

export class BambuMqttClient {
  private client: MqttClient | null = null;
  private options: BambuClientOptions;
  private messageCallbacks: Set<OnMessageCallback> = new Set();
  private connected: boolean = false;

  constructor(options: BambuClientOptions) {
    this.options = options;
  }

  public async connect(): Promise<void> {
    if (this.client) {
      return;
    }

    const { host, port, accessCode } = this.options;
    const clientId = `bambu-h2d-gateway-${Math.random().toString(36).substring(2, 9)}`;

    logger.info({ host, port }, 'MQTT connecting');

    return new Promise<void>((resolve, reject) => {
      let resolved = false;

      const brokerUrl = `mqtts://${host}:${port}`;
      this.client = mqtt.connect(brokerUrl, {
        username: 'bblp',
        password: accessCode,
        rejectUnauthorized: false,
        clientId,
        clean: true,
        reconnectPeriod: this.options.reconnectPeriod ?? 5000,
        connectTimeout: 10000,
      });

      this.client.on('connect', () => {
        this.connected = true;
        logger.info({ host, port }, 'MQTT connected');
        if (!resolved) {
          resolved = true;
          resolve();
        }
      });

      this.client.on('reconnect', () => {
        logger.info('MQTT reconnecting');
      });

      this.client.on('close', () => {
        this.connected = false;
        logger.info('MQTT disconnected');
      });

      this.client.on('error', (err) => {
        logger.error({ error: err.message }, 'MQTT error');
        if (!resolved) {
          resolved = true;
          // Don't throw/reject on connection failure if we want auto-reconnect, but resolving initial promise or rejecting
          reject(err);
        }
      });

      this.client.on('message', (topic, message) => {
        for (const callback of this.messageCallbacks) {
          try {
            callback(topic, message);
          } catch (err) {
            logger.error({ error: err instanceof Error ? err.message : String(err) }, 'Error in MQTT message callback');
          }
        }
      });
    });
  }

  public async subscribeReports(): Promise<void> {
    if (!this.client || !this.connected) {
      throw new Error('Cannot subscribe to report topic: MQTT client is not connected');
    }

    const topic = BambuTopics.getReportTopic(this.options.serial);
    return new Promise((resolve, reject) => {
      this.client!.subscribe(topic, { qos: 0 }, (err) => {
        if (err) {
          logger.error({ topic, error: err.message }, 'Failed to subscribe to MQTT report topic');
          reject(err);
        } else {
          logger.info({ topic }, `Subscribed: ${topic}`);
          resolve();
        }
      });
    });
  }

  public onMessage(callback: OnMessageCallback): void {
    this.messageCallbacks.add(callback);
  }

  public async publishRequest(payload: Record<string, unknown>): Promise<boolean> {
    if (!this.client || !this.isConnected()) {
      logger.warn('Cannot publish MQTT request: client is not connected');
      return false;
    }

    const topic = `device/${this.options.serial}/request`;
    const jsonStr = JSON.stringify(payload);

    return new Promise((resolve) => {
      this.client!.publish(topic, jsonStr, { qos: 0 }, (err) => {
        if (err) {
          logger.error({ topic, error: err.message }, 'Failed to publish MQTT request');
          resolve(false);
        } else {
          logger.info({ topic }, 'MQTT request payload published successfully');
          resolve(true);
        }
      });
    });
  }

  public isConnected(): boolean {
    return this.connected && (this.client?.connected ?? false);
  }

  public async disconnect(): Promise<void> {
    if (!this.client) {
      return;
    }

    return new Promise((resolve) => {
      this.client!.end(false, {}, () => {
        this.connected = false;
        this.client = null;
        logger.info('MQTT client disconnected explicitly');
        resolve();
      });
    });
  }
}
