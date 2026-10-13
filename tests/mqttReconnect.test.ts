import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'events';

class FakeMqttClient extends EventEmitter {
  connected = false;
  subscribe = vi.fn((_topic: string, _opts: unknown, cb: (err?: Error) => void) => cb());
  publish = vi.fn((_topic: string, _msg: string, _opts: unknown, cb: (err?: Error) => void) => cb());

  simulateConnect() {
    this.connected = true;
    this.emit('connect');
  }

  simulateDrop() {
    this.connected = false;
    this.emit('close');
  }
}

const fake = new FakeMqttClient();
vi.mock('mqtt', () => ({ default: { connect: () => fake } }));

const { BambuMqttClient } = await import('../src/bambu/BambuMqttClient');

describe('BambuMqttClient reconnect handling', () => {
  it('runs onConnect callbacks on the first connect and on every auto-reconnect', async () => {
    const client = new BambuMqttClient({ host: 'printer', port: 8883, accessCode: 'x', serial: 'SERIAL' });
    client.onConnect(async () => {
      await client.subscribeReports();
    });

    // Printer offline at boot: the initial connect fails, mqtt.js keeps retrying in the background
    const initial = client.connect();
    fake.emit('error', new Error('ECONNREFUSED'));
    await expect(initial).rejects.toThrow('ECONNREFUSED');
    expect(fake.subscribe).not.toHaveBeenCalled();

    fake.simulateConnect();
    await vi.waitFor(() => expect(fake.subscribe).toHaveBeenCalledTimes(1));

    // Clean session: the broker forgets the subscription across a drop, so it must be renewed
    fake.simulateDrop();
    fake.simulateConnect();
    await vi.waitFor(() => expect(fake.subscribe).toHaveBeenCalledTimes(2));
    expect(fake.subscribe.mock.calls[1][0]).toBe('device/SERIAL/report');
  });
});
