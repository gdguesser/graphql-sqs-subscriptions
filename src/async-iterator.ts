interface IteratorPubSub {
  subscribe(
    triggerName: string,
    onMessage: (payload: unknown) => void,
    options?: object
  ): Promise<number>;
  unsubscribe(subscriptionId: number): Promise<void>;
}

interface PullRequest<T> {
  resolve: (result: IteratorResult<T>) => void;
  reject: (error: unknown) => void;
}

/**
 * Public-API-compatible async iterator without importing implementation files
 * from graphql-subscriptions.
 */
export class SQSPubSubAsyncIterator<T> implements AsyncIterableIterator<T> {
  private readonly triggers: readonly string[];
  private readonly pullQueue: Array<PullRequest<T>> = [];
  private readonly pushQueue: T[] = [];
  private subscriptionPromise?: Promise<number[]>;
  private cleanupPromise?: Promise<void>;
  private listening = true;

  public constructor(
    private readonly pubSub: IteratorPubSub,
    triggers: string | readonly string[]
  ) {
    this.triggers = Array.isArray(triggers) ? triggers : [triggers];

    if (this.triggers.length === 0) {
      throw new TypeError("At least one trigger name is required");
    }
  }

  public async next(): Promise<IteratorResult<T>> {
    if (!this.listening) {
      return { value: undefined, done: true };
    }

    await this.ensureSubscribed();

    if (!this.listening) {
      return { value: undefined, done: true };
    }

    const value = this.pushQueue.shift();
    if (value !== undefined) {
      return { value, done: false };
    }

    return new Promise<IteratorResult<T>>((resolve, reject) => {
      this.pullQueue.push({ resolve, reject });
    });
  }

  public async return(): Promise<IteratorResult<T>> {
    await this.cleanup();
    this.resolvePendingAsDone();
    return { value: undefined, done: true };
  }

  public async throw(error: unknown): Promise<IteratorResult<T>> {
    await this.cleanup();
    this.rejectPending(error);
    throw error;
  }

  public [Symbol.asyncIterator](): AsyncIterableIterator<T> {
    return this;
  }

  private readonly pushValue = (payload: unknown): void => {
    if (!this.listening) {
      return;
    }

    const pullRequest = this.pullQueue.shift();
    if (pullRequest) {
      pullRequest.resolve({ value: payload as T, done: false });
      return;
    }

    this.pushQueue.push(payload as T);
  };

  private ensureSubscribed(): Promise<number[]> {
    if (!this.subscriptionPromise) {
      this.subscriptionPromise = this.subscribeAll();
    }

    return this.subscriptionPromise;
  }

  private async subscribeAll(): Promise<number[]> {
    const subscriptionIds: number[] = [];

    try {
      for (const trigger of this.triggers) {
        const subscriptionId = await this.pubSub.subscribe(
          trigger,
          this.pushValue,
          {}
        );
        subscriptionIds.push(subscriptionId);
      }
    } catch (error) {
      await Promise.allSettled(
        subscriptionIds.map((subscriptionId) =>
          this.pubSub.unsubscribe(subscriptionId)
        )
      );
      throw error;
    }

    if (!this.listening) {
      await Promise.allSettled(
        subscriptionIds.map((subscriptionId) =>
          this.pubSub.unsubscribe(subscriptionId)
        )
      );
      return [];
    }

    return subscriptionIds;
  }

  private cleanup(): Promise<void> {
    if (this.cleanupPromise) {
      return this.cleanupPromise;
    }

    this.listening = false;
    this.pushQueue.length = 0;
    this.cleanupPromise = this.unsubscribeAll();
    return this.cleanupPromise;
  }

  private async unsubscribeAll(): Promise<void> {
    if (!this.subscriptionPromise) {
      return;
    }

    let subscriptionIds: number[];
    try {
      subscriptionIds = await this.subscriptionPromise;
    } catch {
      return;
    }

    await Promise.allSettled(
      subscriptionIds.map((subscriptionId) =>
        this.pubSub.unsubscribe(subscriptionId)
      )
    );
  }

  private resolvePendingAsDone(): void {
    for (const pullRequest of this.pullQueue.splice(0)) {
      pullRequest.resolve({ value: undefined, done: true });
    }
  }

  private rejectPending(error: unknown): void {
    for (const pullRequest of this.pullQueue.splice(0)) {
      pullRequest.reject(error);
    }
  }
}
