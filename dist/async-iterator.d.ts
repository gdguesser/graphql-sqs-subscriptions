interface IteratorPubSub {
    subscribe(triggerName: string, onMessage: (payload: unknown) => void, options?: object): Promise<number>;
    unsubscribe(subscriptionId: number): Promise<void>;
}
/**
 * Public-API-compatible async iterator without importing implementation files
 * from graphql-subscriptions.
 */
export declare class SQSPubSubAsyncIterator<T> implements AsyncIterableIterator<T> {
    private readonly pubSub;
    private readonly triggers;
    private readonly pullQueue;
    private readonly pushQueue;
    private subscriptionPromise?;
    private cleanupPromise?;
    private listening;
    constructor(pubSub: IteratorPubSub, triggers: string | readonly string[]);
    next(): Promise<IteratorResult<T>>;
    return(): Promise<IteratorResult<T>>;
    throw(error: unknown): Promise<IteratorResult<T>>;
    [Symbol.asyncIterator](): AsyncIterableIterator<T>;
    private readonly pushValue;
    private ensureSubscribed;
    private subscribeAll;
    private cleanup;
    private unsubscribeAll;
    private resolvePendingAsDone;
    private rejectPending;
}
export {};
//# sourceMappingURL=async-iterator.d.ts.map