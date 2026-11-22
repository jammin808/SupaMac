// The queues are listed three times: in the queue service's config, which
// creates them; in init-aws.sh, which sets their attributes; and in
// compose.yaml, which tells the services where they are. All three follow
// the local stack's catalogue in the Rust tree. A worker whose queue is
// missing retries in a tight loop, and one whose queue has other attributes
// than it counts on sees a message twice or for ever, so the lists are held
// to each other here.

import { existsSync } from 'node:fs';
import { file } from 'bun';
import { expect, test } from 'bun:test';
import {
  configPath,
  configQueues,
  type Queue,
  scriptPath,
  scriptQueues,
} from './queue-lists';

// The checkout, where compose.yaml sits beside ops/. The ops image holds
// this directory's config, scripts and programs and nothing else of the
// repository, so the tests against the catalogue run from a checkout only.
const composePath = new URL('../../compose.yaml', import.meta.url);
const cataloguePath = new URL(
  '../../../../tooling/xtask/crates/xtask_local/src/local/resources.rs',
  import.meta.url
);
const queueTypesPath = new URL(
  '../../../../crates/macro_queues/src/lib.rs',
  import.meta.url
);
const inCheckout = existsSync(composePath);

// What this stack gives a queue beyond the catalogue: the attributes of the
// deployed queue that its worker counts on (elasticmq.conf says why).
const BEYOND_CATALOGUE: Record<string, Queue> = {
  'contacts-queue': {
    deadLetters: { queue: 'contacts-dlq', receives: 5 },
  },
  'search-event-queue': {
    visibility: 120,
    deadLetters: { queue: 'search-event-queue-dlq', receives: 2 },
  },
};
// The dead-letter queues those two name, which the catalogue does not have.
const OWN_QUEUES = ['contacts-dlq', 'search-event-queue-dlq'];

function sorted<T>(entries: Map<string, T>): [string, T][] {
  return [...entries].sort(([a], [b]) => a.localeCompare(b));
}

test('the queue service is given, and init-aws.sh sets, the same queues and attributes', async () => {
  const config = configQueues(await file(configPath).text());
  const script = scriptQueues(await file(scriptPath).text());

  expect(script.size).toBeGreaterThan(0);
  expect(sorted(script)).toEqual(sorted(config.queues));
});

test('a FIFO queue is the one whose name ends in .fifo, which is how init-aws.sh tells', async () => {
  const config = configQueues(await file(configPath).text());

  const named = [...config.queues.keys()].filter((name) =>
    name.endsWith('.fifo')
  );
  expect([...config.fifo].sort()).toEqual(named.sort());
});

test('init-aws.sh makes sure of a dead-letter queue before the queue that names it', async () => {
  const script = scriptQueues(await file(scriptPath).text());

  const seen = new Set<string>();
  const namedTooEarly: string[] = [];
  for (const [name, queue] of script) {
    if (queue.deadLetters && !seen.has(queue.deadLetters.queue)) {
      namedTooEarly.push(name);
    }
    seen.add(name);
  }
  expect(namedTooEarly).toEqual([]);
});

/** `SlackImportDlq` as the override variable the queue type reads. */
function overrideVariable(type: string): string {
  return `OVERRIDE_${type.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase()}`;
}

/** The local stack's catalogue: each queue, its attributes and its variables. */
async function catalogue(): Promise<{
  queues: Map<string, Queue>;
  bindings: Map<string, string>;
}> {
  const types = await file(queueTypesPath).text();
  const localName = new Map<string, string>();
  for (const [, type, name] of types.matchAll(
    /pub (\w+) \{\s*local: "([^"]+)"/g
  )) {
    localName.set(type, name);
  }
  const nameOf = (type: string): string => {
    const name = localName.get(type);
    if (name === undefined) {
      throw new Error(`macro_queues has no queue type ${type}`);
    }
    return name;
  };

  const text = await file(cataloguePath).text();
  const constants = new Map<string, string>();
  for (const [, constant, type] of text.matchAll(
    /pub const (\w+): &str =\s*macro_queues::(\w+)::LOCAL;/g
  )) {
    constants.set(constant, nameOf(type));
  }

  const listStart = text.indexOf('pub const QUEUES: &[Queue] = &[');
  const listEnd = text.indexOf('\n];', listStart);
  if (listStart < 0 || listEnd < 0) {
    throw new Error('resources.rs has no QUEUES list');
  }
  const queues = new Map<string, Queue>();
  const bindings = new Map<string, string>();
  for (const entry of text
    .slice(listStart, listEnd)
    .split('Queue {')
    .slice(1)) {
    const named = entry.match(/name:\s*(?:macro_queues::(\w+)::LOCAL|(\w+)),/);
    if (!named) {
      throw new Error(`a catalogue queue without a name: ${entry}`);
    }
    const name = named[1] ? nameOf(named[1]) : constants.get(named[2]);
    if (name === undefined) {
      throw new Error(`resources.rs has no queue constant ${named[2]}`);
    }
    queues.set(name, {});

    const bound = [
      ...entry.matchAll(
        /\(\s*(?:"(\w+)"|macro_queues::(\w+)::OVERRIDE_ENV_VAR_NAME),\s*(Name|Url),?\s*\)/g
      ),
    ];
    if (bound.length === 0) {
      throw new Error(`${name}: no variable is bound to it`);
    }
    for (const [, literal, type, form] of bound) {
      bindings.set(
        literal ?? overrideVariable(type),
        form === 'Url' ? `http://localstack:4566/000000000000/${name}` : name
      );
    }
  }

  // The arms of `Queue::attributes`, each for one or more queue types.
  const armsStart = text.indexOf('match self.name {');
  const armsEnd = text.indexOf('_ => Default::default()', armsStart);
  if (armsStart < 0 || armsEnd < 0) {
    throw new Error('resources.rs has no queue attributes');
  }
  const arms = text.slice(armsStart, armsEnd);
  const heads = [
    ...arms.matchAll(/^\s*((?:macro_queues::\w+::LOCAL(?:\s*\|\s*)?)+)\s*=>/gm),
  ];
  heads.forEach((head, index) => {
    const body = arms.slice(
      (head.index ?? 0) + head[0].length,
      heads[index + 1]?.index ?? arms.length
    );
    const attributes: Queue = {};
    for (const [, attribute] of body.matchAll(/QueueAttributeName::(\w+)/g)) {
      if (attribute === 'VisibilityTimeout' || attribute === 'DelaySeconds') {
        const value = body.match(
          new RegExp(`${attribute},\\s*"(\\d+)"\\.to_string\\(\\)`)
        );
        if (!value) {
          throw new Error(`${head[1]}: ${attribute} is not a number`);
        }
        attributes[attribute === 'DelaySeconds' ? 'delay' : 'visibility'] =
          Number(value[1]);
      } else if (attribute === 'RedrivePolicy') {
        const target = body.match(/queue_arn\(macro_queues::(\w+)::LOCAL\)/);
        const receives = body.match(/"maxReceiveCount":\s*(\d+)/);
        if (!target || !receives) {
          throw new Error(`${head[1]}: a redrive policy this test cannot read`);
        }
        attributes.deadLetters = {
          queue: nameOf(target[1]),
          receives: Number(receives[1]),
        };
      } else if (attribute !== 'MessageRetentionPeriod') {
        // The queue service keeps messages until they are received:
        // retention is the one attribute the stack cannot give a queue.
        throw new Error(`${head[1]}: ${attribute} is not set by this stack`);
      }
    }
    for (const [, type] of head[1].matchAll(/macro_queues::(\w+)::LOCAL/g)) {
      if (!queues.has(nameOf(type))) {
        throw new Error(`${type} has attributes and is not in QUEUES`);
      }
      queues.set(nameOf(type), attributes);
    }
  });

  return { queues, bindings };
}

test.skipIf(!inCheckout)(
  "the stack has every queue of the local stack's catalogue, with its attributes",
  async () => {
    const { queues } = await catalogue();
    const config = configQueues(await file(configPath).text());

    const expected = new Map<string, Queue>(
      OWN_QUEUES.map((name): [string, Queue] => [name, {}])
    );
    for (const [name, queue] of queues) {
      expected.set(name, { ...queue, ...BEYOND_CATALOGUE[name] });
    }
    expect(queues.size).toBeGreaterThan(0);
    expect(sorted(config.queues)).toEqual(sorted(expected));
  }
);

test.skipIf(!inCheckout)(
  'compose.yaml gives the services every queue variable the catalogue binds',
  async () => {
    const { bindings } = await catalogue();
    const compose = await file(composePath).text();
    const environment = new Map<string, string>();
    for (const [, key, value] of compose.matchAll(
      /^ {2}([A-Z0-9_]+): (.+)$/gm
    )) {
      environment.set(key, value);
    }

    const given = new Map<string, string | undefined>(
      [...bindings.keys()].map((key) => [key, environment.get(key)])
    );
    expect(bindings.size).toBeGreaterThan(0);
    expect(sorted(given)).toEqual(sorted(bindings));
  }
);
