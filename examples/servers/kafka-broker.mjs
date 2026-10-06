/**
 * A small in-process Kafka broker for tests and demos. Nothing here talks to the internet.
 *
 *   import { startKafkaBroker } from './kafka-broker.mjs';
 *   const broker = await startKafkaBroker({ port: 9092, topics: { orders: 1 } });
 *   // new Kafka({ brokers: [broker.url] }) ... await broker.close();
 *
 * One broker (node id 0) that is its own controller and group coordinator. Topics live in memory,
 * one append-only log per partition. The byte work reuses kafkajs's own protocol code (Encoder,
 * Decoder, RecordBatch), so the wire format matches what kafkajs writes and reads.
 *
 * APIs (key: versions): Produce 0: v3, Fetch 1: v4, ListOffsets 2: v1, Metadata 3: v0-v4,
 * OffsetCommit 8: v2, OffsetFetch 9: v1, FindCoordinator 10: v0, JoinGroup 11: v0-v2, Heartbeat 12: v0,
 * LeaveGroup 13: v0, SyncGroup 14: v0, DescribeGroups 15: v0, ListGroups 16: v0, ApiVersions 18: v0-v2,
 * CreateTopics 19: v0, DeleteTopics 20: v0.
 *
 * Limits: no SASL/TLS, no transactions or idempotence bookkeeping, compression other than gzip is
 * not decoded (kafkajs only ships gzip), no retention, replication factor is always 1.
 */
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';

const require = createRequire(import.meta.url);
const Encoder = require('kafkajs/src/protocol/encoder');
const Decoder = require('kafkajs/src/protocol/decoder');
const { RecordBatch } = require('kafkajs/src/protocol/recordBatch/v0');
const RecordBatchDecoder = require('kafkajs/src/protocol/recordBatch/v0/decoder');
const Record = require('kafkajs/src/protocol/recordBatch/record/v0');

const NODE_ID = 0;
const CLUSTER_ID = 'testpion-kafka';

const ERR = {
  NONE: 0,
  OFFSET_OUT_OF_RANGE: 1,
  UNKNOWN_TOPIC_OR_PARTITION: 3,
  ILLEGAL_GENERATION: 22,
  INCONSISTENT_GROUP_PROTOCOL: 23,
  UNKNOWN_MEMBER_ID: 25,
  REBALANCE_IN_PROGRESS: 27,
  UNSUPPORTED_VERSION: 35,
  TOPIC_ALREADY_EXISTS: 36,
  INVALID_PARTITIONS: 37,
};

// apiKey -> [minVersion, maxVersion]
const SUPPORTED = {
  0: [3, 3], // Produce
  1: [4, 4], // Fetch
  2: [1, 1], // ListOffsets
  3: [0, 4], // Metadata
  8: [2, 2], // OffsetCommit
  9: [1, 1], // OffsetFetch
  10: [0, 0], // FindCoordinator
  11: [0, 2], // JoinGroup
  12: [0, 0], // Heartbeat
  13: [0, 0], // LeaveGroup
  14: [0, 0], // SyncGroup
  15: [0, 0], // DescribeGroups
  16: [0, 0], // ListGroups
  18: [0, 2], // ApiVersions
  19: [0, 0], // CreateTopics
  20: [0, 0], // DeleteTopics
};

const num = (long) => Number(long.toString());
const readNum64 = (d) => num(d.readInt64());

/** A stored record: { offset, timestamp, key, value, headers }. */
function makeTopic(name, partitions) {
  return { name, partitions: Array.from({ length: partitions }, (_, partition) => ({ partition, records: [] })) };
}

export async function startKafkaBroker({ port = 0, host = '127.0.0.1', topics = {}, autoCreateTopics = true } = {}) {
  /** @type {Map<string, {name: string, partitions: {partition: number, records: any[]}[]}>} */
  const topicMap = new Map();
  for (const [name, count] of Object.entries(topics)) topicMap.set(name, makeTopic(name, Math.max(1, Number(count) || 1)));

  const groups = new Map();
  const sockets = new Set();
  const dataWaiters = new Set();
  let closed = false;
  let advertisedPort = port;

  const notifyData = () => {
    for (const wake of [...dataWaiters]) wake();
  };
  const waitForData = (ms) =>
    new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        dataWaiters.delete(done);
        resolve();
      };
      const timer = setTimeout(done, Math.max(0, ms));
      dataWaiters.add(done);
    });

  const ensureTopic = (name, allowCreate) => {
    let t = topicMap.get(name);
    if (!t && allowCreate && autoCreateTopics) {
      t = makeTopic(name, 1);
      topicMap.set(name, t);
    }
    return t;
  };

  const highWatermark = (p) => p.records.length;

  // ---------------------------------------------------------------- consumer groups

  const getGroup = (groupId, create) => {
    let g = groups.get(groupId);
    if (!g && create) {
      g = { groupId, generationId: 0, state: 'Empty', protocolType: '', protocol: '', leaderId: '', members: new Map(), offsets: new Map(), timer: null };
      groups.set(groupId, g);
    }
    return g;
  };

  const failPendingSyncs = (g, errorCode) => {
    for (const m of g.members.values()) {
      if (m.pendingSync) {
        const r = m.pendingSync;
        m.pendingSync = null;
        r({ errorCode, assignment: Buffer.alloc(0) });
      }
    }
  };

  const completeRebalance = (g) => {
    clearTimeout(g.timer);
    g.timer = null;
    for (const [id, m] of g.members) if (!m.pendingJoin) g.members.delete(id);
    if (g.members.size === 0) {
      g.state = 'Empty';
      g.leaderId = '';
      return;
    }
    g.generationId += 1;
    if (!g.members.has(g.leaderId)) g.leaderId = g.members.keys().next().value;
    const leader = g.members.get(g.leaderId);
    const all = [...g.members.values()];
    const protocol = leader.protocols.map((p) => p.name).find((name) => all.every((m) => m.protocols.some((p) => p.name === name)));
    if (protocol === undefined) {
      for (const m of all) {
        const r = m.pendingJoin;
        m.pendingJoin = null;
        r({ errorCode: ERR.INCONSISTENT_GROUP_PROTOCOL });
      }
      g.members.clear();
      g.state = 'Empty';
      return;
    }
    g.protocol = protocol;
    g.state = 'CompletingRebalance';
    const memberList = all.map((m) => ({ memberId: m.memberId, metadata: m.protocols.find((p) => p.name === protocol).metadata }));
    for (const m of all) {
      m.assignment = Buffer.alloc(0);
      const r = m.pendingJoin;
      m.pendingJoin = null;
      r({ errorCode: ERR.NONE, generationId: g.generationId, protocol, leaderId: g.leaderId, memberId: m.memberId, members: m.memberId === g.leaderId ? memberList : [] });
    }
  };

  const checkRebalance = (g) => {
    if (g.state !== 'PreparingRebalance') return;
    if ([...g.members.values()].every((m) => m.pendingJoin)) completeRebalance(g);
  };

  const triggerRebalance = (g) => {
    if (g.state !== 'PreparingRebalance') {
      failPendingSyncs(g, ERR.REBALANCE_IN_PROGRESS);
      g.state = 'PreparingRebalance';
      const wait = Math.min(60_000, Math.max(1000, ...[...g.members.values()].map((m) => m.rebalanceTimeout)));
      clearTimeout(g.timer);
      g.timer = setTimeout(() => completeRebalance(g), wait);
    }
    if (g.members.size === 0) {
      clearTimeout(g.timer);
      g.state = 'Empty';
      return;
    }
    checkRebalance(g);
  };

  const sweep = setInterval(() => {
    const now = Date.now();
    for (const g of groups.values()) {
      if (g.state === 'Empty') continue;
      let expired = false;
      for (const [id, m] of g.members) {
        if (!m.pendingJoin && now - m.lastSeen > m.sessionTimeout) {
          g.members.delete(id);
          if (m.pendingSync) m.pendingSync({ errorCode: ERR.UNKNOWN_MEMBER_ID, assignment: Buffer.alloc(0) });
          expired = true;
        }
      }
      if (expired) triggerRebalance(g);
    }
  }, 1000);
  sweep.unref();

  // ---------------------------------------------------------------- request handlers

  const handlers = {
    // ApiVersions
    18: (v) => {
      const e = new Encoder().writeInt16(ERR.NONE);
      const entries = Object.entries(SUPPORTED).map(([key, [min, max]]) => new Encoder().writeInt16(Number(key)).writeInt16(min).writeInt16(max));
      e.writeArray(entries);
      if (v >= 1) e.writeInt32(0);
      return e;
    },

    // Metadata
    3: (v, d) => {
      const requested = d.readArray((x) => x.readString());
      const allowCreate = v >= 4 ? d.readBoolean() : true;
      const list = requested.length === 0 ? [...topicMap.values()].map((t) => ({ name: t.name, topic: t })) : requested.map((name) => ({ name, topic: ensureTopic(name, allowCreate) }));
      const e = new Encoder();
      if (v >= 3) e.writeInt32(0);
      const brokerEnc = new Encoder().writeInt32(NODE_ID).writeString(host).writeInt32(advertisedPort);
      if (v >= 1) brokerEnc.writeString(null);
      e.writeArray([brokerEnc]);
      if (v >= 2) e.writeString(CLUSTER_ID);
      if (v >= 1) e.writeInt32(NODE_ID);
      e.writeArray(
        list.map(({ name, topic }) => {
          const t = new Encoder().writeInt16(topic ? ERR.NONE : ERR.UNKNOWN_TOPIC_OR_PARTITION).writeString(name);
          if (v >= 1) t.writeBoolean(false);
          t.writeArray((topic ? topic.partitions : []).map((p) => new Encoder().writeInt16(ERR.NONE).writeInt32(p.partition).writeInt32(NODE_ID).writeArray([NODE_ID]).writeArray([NODE_ID])));
          return t;
        }),
      );
      return e;
    },

    // Produce v3
    0: async (v, d) => {
      d.readString(); // transactional id
      const acks = d.readInt16();
      d.readInt32(); // timeout
      const topicResults = [];
      const nTopics = d.readInt32();
      let appended = false;
      for (let i = 0; i < nTopics; i++) {
        const name = d.readString();
        const nParts = d.readInt32();
        const partResults = [];
        for (let j = 0; j < nParts; j++) {
          const partition = d.readInt32();
          const recordSet = d.readBytes();
          const topic = ensureTopic(name, true);
          const p = topic?.partitions[partition];
          if (!p) {
            partResults.push({ partition, errorCode: ERR.UNKNOWN_TOPIC_OR_PARTITION, baseOffset: -1 });
            continue;
          }
          const decoded = [];
          const rd = new Decoder(recordSet ?? Buffer.alloc(0));
          while (rd.offset < rd.buffer.length) {
            const batch = await RecordBatchDecoder(rd);
            decoded.push(...batch.records);
          }
          const baseOffset = p.records.length;
          for (const r of decoded) {
            p.records.push({ offset: p.records.length, timestamp: Number(r.timestamp), key: r.key, value: r.value, headers: r.headers ?? {} });
          }
          if (decoded.length) appended = true;
          partResults.push({ partition, errorCode: ERR.NONE, baseOffset });
        }
        topicResults.push({ name, partResults });
      }
      if (appended) notifyData();
      if (acks === 0) return null;
      return new Encoder()
        .writeArray(
          topicResults.map(({ name, partResults }) =>
            new Encoder().writeString(name).writeArray(partResults.map((r) => new Encoder().writeInt32(r.partition).writeInt16(r.errorCode).writeInt64(r.baseOffset).writeInt64(-1))),
          ),
        )
        .writeInt32(0);
    },

    // Fetch v4
    1: async (v, d) => {
      d.readInt32(); // replica id
      const maxWaitTime = d.readInt32();
      d.readInt32(); // min bytes
      const maxBytes = d.readInt32();
      d.readInt8(); // isolation level
      const requests = d.readArray((t) => ({
        topic: t.readString(),
        partitions: t.readArray((p) => ({ partition: p.readInt32(), fetchOffset: readNum64(p), maxBytes: p.readInt32() })),
      }));

      const collect = () => {
        let total = 0;
        let budget = maxBytes > 0 ? maxBytes : Infinity;
        const out = requests.map(({ topic, partitions }) => ({
          topic,
          partitions: partitions.map(({ partition, fetchOffset, maxBytes: partMax }) => {
            const p = topicMap.get(topic)?.partitions[partition];
            if (!p) return { partition, errorCode: ERR.UNKNOWN_TOPIC_OR_PARTITION, hw: -1, records: [] };
            const hw = highWatermark(p);
            if (fetchOffset < 0 || fetchOffset > hw) return { partition, errorCode: ERR.OFFSET_OUT_OF_RANGE, hw, records: [] };
            const records = [];
            let size = 0;
            const limit = Math.min(partMax > 0 ? partMax : Infinity, budget);
            for (let o = fetchOffset; o < hw; o++) {
              const r = p.records[o];
              let s = 24 + (r.key?.length ?? 0) + (r.value?.length ?? 0);
              for (const [k, val] of Object.entries(r.headers)) for (const x of [].concat(val)) s += k.length + (x?.length ?? 0) + 4;
              if (records.length > 0 && size + s > limit) break;
              records.push(r);
              size += s;
            }
            budget -= size;
            total += records.length;
            return { partition, errorCode: ERR.NONE, hw, records };
          }),
        }));
        return { out, total };
      };

      let { out, total } = collect();
      if (total === 0 && maxWaitTime > 0 && !closed && out.some((t) => t.partitions.some((p) => p.errorCode === ERR.NONE))) {
        await waitForData(maxWaitTime);
        ({ out } = collect());
      }

      const topicEncs = [];
      for (const { topic, partitions } of out) {
        const partEncs = [];
        for (const p of partitions) {
          const pe = new Encoder().writeInt32(p.partition).writeInt16(p.errorCode).writeInt64(p.hw).writeInt64(p.hw).writeArray([]);
          if (p.records.length === 0) {
            pe.writeInt32(0);
          } else {
            const first = p.records[0];
            const timestamps = p.records.map((r) => r.timestamp);
            const batch = await RecordBatch({
              firstOffset: first.offset,
              firstTimestamp: first.timestamp,
              maxTimestamp: Math.max(...timestamps),
              lastOffsetDelta: p.records.length - 1,
              records: p.records.map((r, i) => Record({ offsetDelta: i, timestampDelta: r.timestamp - first.timestamp, key: r.key, value: r.value, headers: r.headers })),
            });
            pe.writeBytes(batch.buffer);
          }
          partEncs.push(pe);
        }
        topicEncs.push(new Encoder().writeString(topic).writeArray(partEncs));
      }
      return new Encoder().writeInt32(0).writeArray(topicEncs);
    },

    // ListOffsets v1
    2: (v, d) => {
      d.readInt32(); // replica id
      const reqs = d.readArray((t) => ({ topic: t.readString(), partitions: t.readArray((p) => ({ partition: p.readInt32(), timestamp: readNum64(p) })) }));
      return new Encoder().writeArray(
        reqs.map(({ topic, partitions }) =>
          new Encoder().writeString(topic).writeArray(
            partitions.map(({ partition, timestamp }) => {
              const p = topicMap.get(topic)?.partitions[partition];
              if (!p) return new Encoder().writeInt32(partition).writeInt16(ERR.UNKNOWN_TOPIC_OR_PARTITION).writeInt64(-1).writeInt64(-1);
              let offset;
              if (timestamp === -1) offset = highWatermark(p);
              else if (timestamp === -2) offset = 0;
              else {
                const hit = p.records.find((r) => r.timestamp >= timestamp);
                offset = hit ? hit.offset : highWatermark(p);
              }
              return new Encoder().writeInt32(partition).writeInt16(ERR.NONE).writeInt64(-1).writeInt64(offset);
            }),
          ),
        ),
      );
    },

    // FindCoordinator v0
    10: (v, d) => {
      d.readString();
      return new Encoder().writeInt16(ERR.NONE).writeInt32(NODE_ID).writeString(host).writeInt32(advertisedPort);
    },

    // JoinGroup v0-v2
    11: async (v, d, ctx) => {
      const groupId = d.readString();
      const sessionTimeout = d.readInt32();
      const rebalanceTimeout = v >= 1 ? d.readInt32() : sessionTimeout;
      let memberId = d.readString() ?? '';
      const protocolType = d.readString();
      const protocols = d.readArray((p) => ({ name: p.readString(), metadata: p.readBytes() }));

      const reply = (r) => {
        const e = new Encoder();
        if (v >= 2) e.writeInt32(0);
        e.writeInt16(r.errorCode)
          .writeInt32(r.generationId ?? -1)
          .writeString(r.protocol ?? '')
          .writeString(r.leaderId ?? '')
          .writeString(r.memberId ?? memberId)
          .writeArray((r.members ?? []).map((m) => new Encoder().writeString(m.memberId).writeBytes(m.metadata)));
        return e;
      };

      const g = getGroup(groupId, true);
      if (g.members.size > 0 && g.protocolType && g.protocolType !== protocolType) return reply({ errorCode: ERR.INCONSISTENT_GROUP_PROTOCOL });
      let member;
      if (memberId === '') {
        memberId = `${ctx.clientId ?? 'member'}-${randomUUID()}`;
        member = { memberId, clientId: ctx.clientId ?? '', clientHost: ctx.clientHost };
        g.members.set(memberId, member);
      } else {
        member = g.members.get(memberId);
        if (!member) return reply({ errorCode: ERR.UNKNOWN_MEMBER_ID });
      }
      g.protocolType = protocolType;
      Object.assign(member, { sessionTimeout, rebalanceTimeout, protocols, lastSeen: Date.now() });
      const result = new Promise((resolve) => {
        if (member.pendingJoin) member.pendingJoin({ errorCode: ERR.REBALANCE_IN_PROGRESS });
        member.pendingJoin = resolve;
      });
      triggerRebalance(g);
      return reply(await result);
    },

    // SyncGroup v0
    14: async (v, d) => {
      const groupId = d.readString();
      const generationId = d.readInt32();
      const memberId = d.readString();
      const assignments = d.readArray((a) => ({ memberId: a.readString(), assignment: a.readBytes() }));
      const reply = ({ errorCode, assignment }) => new Encoder().writeInt16(errorCode).writeBytes(assignment ?? Buffer.alloc(0));

      const g = getGroup(groupId, false);
      const member = g?.members.get(memberId);
      if (!member) return reply({ errorCode: ERR.UNKNOWN_MEMBER_ID });
      member.lastSeen = Date.now();
      if (g.state === 'PreparingRebalance') return reply({ errorCode: ERR.REBALANCE_IN_PROGRESS });
      if (generationId !== g.generationId) return reply({ errorCode: ERR.ILLEGAL_GENERATION });
      if (memberId === g.leaderId && g.state === 'CompletingRebalance') {
        for (const m of g.members.values()) m.assignment = assignments.find((a) => a.memberId === m.memberId)?.assignment ?? Buffer.alloc(0);
        g.state = 'Stable';
        for (const m of g.members.values()) {
          if (m.pendingSync) {
            const r = m.pendingSync;
            m.pendingSync = null;
            r({ errorCode: ERR.NONE, assignment: m.assignment });
          }
        }
      }
      if (g.state === 'Stable') return reply({ errorCode: ERR.NONE, assignment: member.assignment });
      return reply(await new Promise((resolve) => (member.pendingSync = resolve)));
    },

    // Heartbeat v0
    12: (v, d) => {
      const groupId = d.readString();
      const generationId = d.readInt32();
      const memberId = d.readString();
      const g = getGroup(groupId, false);
      const member = g?.members.get(memberId);
      let errorCode = ERR.NONE;
      if (!member) errorCode = ERR.UNKNOWN_MEMBER_ID;
      else {
        member.lastSeen = Date.now();
        if (g.state === 'PreparingRebalance') errorCode = ERR.REBALANCE_IN_PROGRESS;
        else if (generationId !== g.generationId) errorCode = ERR.ILLEGAL_GENERATION;
      }
      return new Encoder().writeInt16(errorCode);
    },

    // LeaveGroup v0
    13: (v, d) => {
      const groupId = d.readString();
      const memberId = d.readString();
      const g = getGroup(groupId, false);
      const member = g?.members.get(memberId);
      if (!member) return new Encoder().writeInt16(ERR.UNKNOWN_MEMBER_ID);
      g.members.delete(memberId);
      if (member.pendingJoin) member.pendingJoin({ errorCode: ERR.UNKNOWN_MEMBER_ID });
      if (member.pendingSync) member.pendingSync({ errorCode: ERR.UNKNOWN_MEMBER_ID });
      if (g.members.size === 0) {
        clearTimeout(g.timer);
        g.state = 'Empty';
        g.leaderId = '';
      } else triggerRebalance(g);
      return new Encoder().writeInt16(ERR.NONE);
    },

    // OffsetCommit v2
    8: (v, d) => {
      const groupId = d.readString();
      const generationId = d.readInt32();
      const memberId = d.readString();
      d.readInt64(); // retention time
      const reqs = d.readArray((t) => ({
        topic: t.readString(),
        partitions: t.readArray((p) => ({ partition: p.readInt32(), offset: readNum64(p), metadata: p.readString() })),
      }));
      const g = getGroup(groupId, true);
      let errorCode = ERR.NONE;
      if (generationId !== -1) {
        const member = g.members.get(memberId);
        if (!member) errorCode = ERR.UNKNOWN_MEMBER_ID;
        else {
          member.lastSeen = Date.now();
          if (g.state === 'PreparingRebalance') errorCode = ERR.REBALANCE_IN_PROGRESS;
          else if (generationId !== g.generationId) errorCode = ERR.ILLEGAL_GENERATION;
        }
      }
      return new Encoder().writeArray(
        reqs.map(({ topic, partitions }) =>
          new Encoder().writeString(topic).writeArray(
            partitions.map(({ partition, offset, metadata }) => {
              if (errorCode === ERR.NONE) g.offsets.set(`${topic}\u0000${partition}`, { offset, metadata: metadata ?? '' });
              return new Encoder().writeInt32(partition).writeInt16(errorCode);
            }),
          ),
        ),
      );
    },

    // OffsetFetch v1
    9: (v, d) => {
      const groupId = d.readString();
      const reqs = d.readArray((t) => ({ topic: t.readString(), partitions: t.readArray((p) => p.readInt32()) }));
      const g = getGroup(groupId, false);
      return new Encoder().writeArray(
        reqs.map(({ topic, partitions }) =>
          new Encoder().writeString(topic).writeArray(
            partitions.map((partition) => {
              const c = g?.offsets.get(`${topic}\u0000${partition}`);
              return new Encoder()
                .writeInt32(partition)
                .writeInt64(c ? c.offset : -1)
                .writeString(c ? c.metadata : '')
                .writeInt16(ERR.NONE);
            }),
          ),
        ),
      );
    },

    // DescribeGroups v0
    15: (v, d) => {
      const ids = d.readArray((x) => x.readString());
      return new Encoder().writeArray(
        ids.map((groupId) => {
          const g = groups.get(groupId);
          const state = !g ? 'Dead' : { Empty: 'Empty', PreparingRebalance: 'PreparingRebalance', CompletingRebalance: 'CompletingRebalance', Stable: 'Stable' }[g.state];
          const members = g ? [...g.members.values()] : [];
          return new Encoder()
            .writeInt16(ERR.NONE)
            .writeString(groupId)
            .writeString(state)
            .writeString(g?.protocolType ?? '')
            .writeString(g?.protocol ?? '')
            .writeArray(
              members.map((m) =>
                new Encoder()
                  .writeString(m.memberId)
                  .writeString(m.clientId)
                  .writeString(m.clientHost)
                  .writeBytes(m.protocols.find((p) => p.name === g.protocol)?.metadata ?? Buffer.alloc(0))
                  .writeBytes(m.assignment ?? Buffer.alloc(0)),
              ),
            );
        }),
      );
    },

    // ListGroups v0
    16: () => new Encoder().writeInt16(ERR.NONE).writeArray([...groups.values()].map((g) => new Encoder().writeString(g.groupId).writeString(g.protocolType || 'consumer'))),

    // CreateTopics v0
    19: (v, d) => {
      const reqs = d.readArray((t) => {
        const r = { topic: t.readString(), numPartitions: t.readInt32() };
        t.readInt16(); // replication factor
        r.assignments = t.readArray((a) => ({ partition: a.readInt32(), replicas: a.readArray((x) => x.readInt32()) }));
        t.readArray((c) => ({ name: c.readString(), value: c.readString() }));
        return r;
      });
      d.readInt32(); // timeout
      return new Encoder().writeArray(
        reqs.map(({ topic, numPartitions, assignments }) => {
          let errorCode = ERR.NONE;
          const count = numPartitions > 0 ? numPartitions : assignments.length || 1;
          if (topicMap.has(topic)) errorCode = ERR.TOPIC_ALREADY_EXISTS;
          else if (numPartitions === 0) errorCode = ERR.INVALID_PARTITIONS;
          else topicMap.set(topic, makeTopic(topic, count));
          return new Encoder().writeString(topic).writeInt16(errorCode);
        }),
      );
    },

    // DeleteTopics v0
    20: (v, d) => {
      const names = d.readArray((x) => x.readString());
      d.readInt32(); // timeout
      return new Encoder().writeArray(names.map((name) => new Encoder().writeString(name).writeInt16(topicMap.delete(name) ? ERR.NONE : ERR.UNKNOWN_TOPIC_OR_PARTITION)));
    },
  };

  // ---------------------------------------------------------------- wire

  const handleFrame = async (socket, frame) => {
    const d = new Decoder(frame);
    const apiKey = d.readInt16();
    const apiVersion = d.readInt16();
    const correlationId = d.readInt32();
    const clientId = d.readString();
    const send = (body) => {
      if (socket.destroyed) return;
      const payload = new Encoder().writeInt32(correlationId).writeEncoder(body).buffer;
      const sized = Buffer.alloc(4 + payload.length);
      sized.writeInt32BE(payload.length, 0);
      payload.copy(sized, 4);
      socket.write(sized);
    };
    const range = SUPPORTED[apiKey];
    if (!range || !handlers[apiKey]) {
      socket.destroy();
      return;
    }
    if (apiVersion < range[0] || apiVersion > range[1]) {
      // only ApiVersions has a defined way to say "unsupported version"; anything else is a client bug
      if (apiKey === 18) {
        const e = new Encoder().writeInt16(ERR.UNSUPPORTED_VERSION);
        e.writeArray(Object.entries(SUPPORTED).map(([key, [min, max]]) => new Encoder().writeInt16(Number(key)).writeInt16(min).writeInt16(max)));
        return send(e);
      }
      socket.destroy();
      return;
    }
    const body = await handlers[apiKey](apiVersion, d, { clientId, clientHost: `/${socket.remoteAddress}` });
    if (body) send(body);
  };

  const server = createServer((socket) => {
    sockets.add(socket);
    socket.setNoDelay(true);
    let buffered = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buffered = buffered.length ? Buffer.concat([buffered, chunk]) : chunk;
      while (buffered.length >= 4) {
        const size = buffered.readInt32BE(0);
        if (buffered.length < 4 + size) break;
        const frame = buffered.subarray(4, 4 + size);
        buffered = buffered.subarray(4 + size);
        handleFrame(socket, frame).catch(() => socket.destroy());
      }
    });
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  advertisedPort = server.address().port;

  return {
    port: advertisedPort,
    host,
    url: `${host}:${advertisedPort}`,
    topics: topicMap,
    async close() {
      if (closed) return;
      closed = true;
      clearInterval(sweep);
      for (const g of groups.values()) clearTimeout(g.timer);
      notifyData();
      for (const s of sockets) s.destroy();
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
