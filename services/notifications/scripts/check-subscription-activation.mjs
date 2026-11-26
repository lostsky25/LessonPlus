import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import console from 'node:console';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { URL } from 'node:url';
import amqp from 'amqplib';
import pg from 'pg';

const exchange = 'lessonplus.events';
const queue = 'lessonplus.notifications.events';
assert.ok(process.env.RABBITMQ_URL && process.env.NOTIFICATIONS_DATABASE_URL);
const broker = new URL(process.env.RABBITMQ_URL);
const management = new URL(
  process.env.RABBITMQ_MANAGEMENT_URL ?? `http://${broker.hostname}:15672`,
);
const vhost = decodeURIComponent(broker.pathname.slice(1)) || '/';
const queueUrl = new URL(`/api/queues/${encodeURIComponent(vhost)}/${queue}`, management);
const credentials = `${decodeURIComponent(broker.username)}:${decodeURIComponent(broker.password)}`;
const db = new pg.Client({
  connectionString: process.env.NOTIFICATIONS_DATABASE_URL,
  connectionTimeoutMillis: 3000,
});
const example = JSON.parse(
  await readFile(
    new URL(
      '../../../packages/contracts/events/examples/SubscriptionActivated.json',
      import.meta.url,
    ),
    'utf8',
  ),
);

async function queueStats() {
  const response = await globalThis.fetch(queueUrl, {
    headers: { Authorization: `Basic ${Buffer.from(credentials).toString('base64')}` },
    signal: globalThis.AbortSignal.timeout(3000),
  });
  assert.ok(response.ok, `RabbitMQ Management returned ${response.status}`);
  return response.json();
}

async function waitForAcks(expected) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const stats = await queueStats();
    if ((stats.message_stats?.ack ?? 0) >= expected) {
      return;
    }
    await delay(250);
  }
  throw new Error(`Expected at least ${expected} acknowledgements`);
}

async function assertRows(event, expected) {
  const { rows: processed } = await db.query(
    'SELECT id FROM notifications.processed_events WHERE id = $1',
    [event.event_id],
  );
  const { rows: notifications } = await db.query(
    `SELECT student_id, subject_type, subject_id, status, channel, next_attempt_no
     FROM notifications.notifications WHERE source_event_id = $1`,
    [event.event_id],
  );
  assert.equal(processed.length, expected);
  assert.equal(notifications.length, expected);
  if (expected === 1) {
    assert.deepEqual(notifications[0], {
      student_id: event.payload.studentId,
      subject_type: 'subscription',
      subject_id: event.payload.subscriptionId,
      status: 'pending',
      channel: 'imitation',
      next_attempt_no: 1,
    });
  }
}

let connection;
try {
  await db.connect();
  connection = await amqp.connect(broker.href, { timeout: 3000 });
  const publisher = await connection.createConfirmChannel();
  const baseline = await queueStats();
  assert.ok(baseline.consumers >= 1, 'Start notifications before running the check');
  let expectedAcks = baseline.message_stats?.ack ?? 0;

  function publish(event) {
    return new Promise((resolve, reject) => {
      publisher.publish(
        exchange,
        event.event_type,
        Buffer.from(JSON.stringify(event)),
        { persistent: true, messageId: event.event_id, contentType: 'application/json' },
        (error) => (error ? reject(error) : resolve()),
      );
    });
  }

  await assertRows(example, 0);
  await publish(example);
  await waitForAcks(++expectedAcks);
  await assertRows(example, 1);
  await publish(example);
  await waitForAcks(++expectedAcks);
  await assertRows(example, 1);
  console.log('Sequential duplicate: 2 acknowledgements, 1 notification, 1 processed event');

  const concurrent = { ...example, event_id: randomUUID() };
  await Promise.all([publish(concurrent), publish(concurrent)]);
  await waitForAcks(expectedAcks + 2);
  await assertRows(concurrent, 1);
  console.log('Concurrent publish: 2 acknowledgements, 1 notification, 1 processed event');
} finally {
  await Promise.allSettled([connection?.close(), db.end()]);
}
