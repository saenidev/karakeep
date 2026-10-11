import path from "node:path";
import {
  buildDBClient,
  SqliteQueue as LQ,
  Runner as LQRunner,
  migrateDB,
  RetryAfterError,
} from "liteque";

import type { PluginProvider } from "@karakeep/shared/plugins";
import type {
  DequeuedJob,
  EnqueueOptions,
  Queue,
  QueueClient,
  QueueOptions,
  Runner,
  RunnerFuncs,
  RunnerOptions,
} from "@karakeep/shared/queueing";
import serverConfig from "@karakeep/shared/config";
import {
  QueueRetryAfterError,
  queueOptionsEqual,
} from "@karakeep/shared/queueing";

// liteque polls every queue with a write transaction each poll interval, which
// keeps an idle workers process busy. Instead, a runner whose last poll came
// back empty waits until there may be new work: a job enqueued by this process
// (immediately), a write by another process such as the web app (noticed within
// EXTERNAL_WRITE_CHECK_MS), or IDLE_MAX_WAIT_MS passing, which catches jobs that
// become due without a write (delayed jobs, backoff retries, expired runs).
const IDLE_MAX_WAIT_MS = 10_000;
const EXTERNAL_WRITE_CHECK_MS = 1_000;
// liteque's own sleep after an empty poll; the waiting above does the rest.
const RUNNER_POLL_INTERVAL_MS = 100;

class QueueActivity {
  // Bumped by writes from other processes; wakes every queue.
  private globalGeneration = 0;
  private queueGenerations = new Map<string, number>();
  private waiters = new Map<string, Set<() => void>>();
  private lastDataVersion: number | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;

  // `readDataVersion` returns SQLite's data_version for the queue connection,
  // which only changes when another connection commits.
  constructor(private readonly readDataVersion: () => number) {}

  generation(queue: string): number {
    return this.globalGeneration + (this.queueGenerations.get(queue) ?? 0);
  }

  notify(queue: string) {
    this.queueGenerations.set(
      queue,
      (this.queueGenerations.get(queue) ?? 0) + 1,
    );
    this.wake(this.waiters.get(queue));
  }

  // Resolves once the queue's generation moves past `seen`, or after timeoutMs.
  async waitForChange(queue: string, seen: number, timeoutMs: number) {
    if (this.generation(queue) !== seen) {
      return;
    }
    this.startWatchingExternalWrites();
    await new Promise<void>((resolve) => {
      let waiters = this.waiters.get(queue);
      if (!waiters) {
        waiters = new Set();
        this.waiters.set(queue, waiters);
      }
      const done = () => {
        clearTimeout(timeout);
        waiters.delete(done);
        resolve();
      };
      const timeout = setTimeout(done, timeoutMs);
      waiters.add(done);
    });
  }

  private wake(waiters: Set<() => void> | undefined) {
    // Each waiter removes itself, which a Set iteration tolerates.
    for (const done of waiters ?? []) {
      done();
    }
  }

  private startWatchingExternalWrites() {
    if (this.timer) {
      return;
    }
    this.lastDataVersion = this.readDataVersion();
    this.timer = setInterval(() => {
      const dataVersion = this.readDataVersion();
      if (dataVersion === this.lastDataVersion) {
        return;
      }
      this.lastDataVersion = dataVersion;
      this.globalGeneration++;
      for (const waiters of this.waiters.values()) {
        this.wake(waiters);
      }
    }, EXTERNAL_WRITE_CHECK_MS);
  }
}

// A view of the queue for liteque's runner whose attemptDequeue waits while
// the queue is idle, as described above QueueActivity.
function idleAwareQueue<T>(
  lq: LQ<T>,
  activity: QueueActivity,
  isStopping: () => boolean,
): LQ<T> {
  const name = lq.name();
  let idle: { generation: number; since: number } | undefined;
  const queue = Object.create(lq) as LQ<T>;
  queue.attemptDequeue = async (options) => {
    if (idle) {
      const remaining = IDLE_MAX_WAIT_MS - (Date.now() - idle.since);
      if (remaining > 0) {
        await activity.waitForChange(name, idle.generation, remaining);
      }
    }
    if (isStopping()) {
      return null;
    }
    const generation = activity.generation(name);
    const job = await lq.attemptDequeue(options);
    idle = job ? undefined : { generation, since: Date.now() };
    return job;
  };
  queue.finalize = async (...args) => {
    await lq.finalize(...args);
    // A finished run frees a slot and may have left a retry behind, and
    // runUntilEmpty() needs to recheck once nothing is in flight.
    activity.notify(name);
  };
  return queue;
}

class LitequeQueueWrapper<T> implements Queue<T> {
  constructor(
    private readonly _name: string,
    private readonly lq: LQ<T>,
    public readonly opts: QueueOptions,
    private readonly activity: QueueActivity,
  ) {}

  ensureInit(): Promise<void> {
    return Promise.resolve();
  }

  name(): string {
    return this._name;
  }

  async enqueue(
    payload: T,
    options?: EnqueueOptions,
  ): Promise<string | undefined> {
    const job = await this.lq.enqueue(payload, options);
    this.activity.notify(this._name);
    // liteque returns a Job with numeric id
    return job ? String(job.id) : undefined;
  }

  async stats() {
    return this.lq.stats();
  }

  async cancelAllNonRunning(): Promise<number> {
    return this.lq.cancelAllNonRunning();
  }

  // Internal accessor for runner
  get _impl(): LQ<T> {
    return this.lq;
  }
}

class LitequeQueueClient implements QueueClient {
  private db = buildDBClient(path.join(serverConfig.dataDir, "queue.db"), {
    walEnabled: serverConfig.database.walMode,
  });

  private activity = new QueueActivity(() => {
    // liteque doesn't expose its better-sqlite3 handle, and its drizzle
    // version keeps it on the session.
    const { client } = (
      this.db as unknown as {
        session: {
          client: {
            pragma(source: string, options: { simple: true }): unknown;
          };
        };
      }
    ).session;
    return client.pragma("data_version", { simple: true }) as number;
  });

  private queues = new Map<string, LitequeQueueWrapper<unknown>>();

  async prepare(): Promise<void> {
    migrateDB(this.db);
  }

  async start(): Promise<void> {
    // No-op for sqlite
  }

  createQueue<T>(name: string, options: QueueOptions): Queue<T> {
    const existing = this.queues.get(name);
    if (existing) {
      if (!queueOptionsEqual(existing.opts, options)) {
        throw new Error(`Queue ${name} already exists with different options`);
      }
      return existing as LitequeQueueWrapper<T>;
    }
    const lq = new LQ<T>(name, this.db, {
      defaultJobArgs: { numRetries: options.defaultJobArgs.numRetries },
      keepFailedJobs: options.keepFailedJobs,
    });
    const wrapper = new LitequeQueueWrapper<T>(
      name,
      lq,
      options,
      this.activity,
    );
    this.queues.set(name, wrapper);
    return wrapper;
  }

  createRunner<T, R = void>(
    queue: Queue<T>,
    funcs: RunnerFuncs<T, R>,
    opts: RunnerOptions<T>,
  ): Runner<T> {
    const name = queue.name();
    let wrapper = this.queues.get(name);
    if (!wrapper) {
      throw new Error(`Queue ${name} not found`);
    }

    // Wrap the run function to translate QueueRetryAfterError to liteque's RetryAfterError
    const wrappedRun = async (job: DequeuedJob<T>): Promise<R> => {
      try {
        return await funcs.run(job);
      } catch (error) {
        if (error instanceof QueueRetryAfterError) {
          // Translate to liteque's native RetryAfterError
          // This will cause liteque to retry after the delay without counting against attempts
          throw new RetryAfterError(error.delayMs);
        }
        // Re-throw any other errors
        throw error;
      }
    };

    let stopping = false;
    const runner = new LQRunner<T, R>(
      idleAwareQueue(wrapper._impl, this.activity, () => stopping),
      {
        run: wrappedRun,
        onComplete: funcs.onComplete,
        onError: funcs.onError,
      },
      {
        pollIntervalMs: opts.pollIntervalMs ?? RUNNER_POLL_INTERVAL_MS,
        timeoutSecs: opts.timeoutSecs,
        concurrency: opts.concurrency,
        validator: opts.validator,
      },
    );

    return {
      run: () => runner.run(),
      stop: () => {
        stopping = true;
        runner.stop();
        // Wake the runner if it's waiting for work so it can exit.
        this.activity.notify(name);
      },
      runUntilEmpty: () => runner.runUntilEmpty(),
    };
  }

  async shutdown(): Promise<void> {
    // No-op for sqlite
  }
}

export class LitequeQueueProvider implements PluginProvider<QueueClient> {
  private client: QueueClient | null = null;

  async getClient(): Promise<QueueClient | null> {
    if (!this.client) {
      const client = new LitequeQueueClient();
      this.client = client;
    }
    return this.client;
  }
}
