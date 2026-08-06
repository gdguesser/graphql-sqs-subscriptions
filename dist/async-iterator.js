"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SQSPubSubAsyncIterator = void 0;
/**
 * Public-API-compatible async iterator without importing implementation files
 * from graphql-subscriptions.
 */
class SQSPubSubAsyncIterator {
    pubSub;
    triggers;
    pullQueue = [];
    pushQueue = [];
    subscriptionPromise;
    cleanupPromise;
    listening = true;
    constructor(pubSub, triggers) {
        this.pubSub = pubSub;
        this.triggers = Array.isArray(triggers) ? triggers : [triggers];
        if (this.triggers.length === 0) {
            throw new TypeError("At least one trigger name is required");
        }
    }
    async next() {
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
        return new Promise((resolve, reject) => {
            this.pullQueue.push({ resolve, reject });
        });
    }
    async return() {
        await this.cleanup();
        this.resolvePendingAsDone();
        return { value: undefined, done: true };
    }
    async throw(error) {
        await this.cleanup();
        this.rejectPending(error);
        throw error;
    }
    [Symbol.asyncIterator]() {
        return this;
    }
    pushValue = (payload) => {
        if (!this.listening) {
            return;
        }
        const pullRequest = this.pullQueue.shift();
        if (pullRequest) {
            pullRequest.resolve({ value: payload, done: false });
            return;
        }
        this.pushQueue.push(payload);
    };
    ensureSubscribed() {
        if (!this.subscriptionPromise) {
            this.subscriptionPromise = this.subscribeAll();
        }
        return this.subscriptionPromise;
    }
    async subscribeAll() {
        const subscriptionIds = [];
        try {
            for (const trigger of this.triggers) {
                const subscriptionId = await this.pubSub.subscribe(trigger, this.pushValue, {});
                subscriptionIds.push(subscriptionId);
            }
        }
        catch (error) {
            await Promise.allSettled(subscriptionIds.map((subscriptionId) => this.pubSub.unsubscribe(subscriptionId)));
            throw error;
        }
        if (!this.listening) {
            await Promise.allSettled(subscriptionIds.map((subscriptionId) => this.pubSub.unsubscribe(subscriptionId)));
            return [];
        }
        return subscriptionIds;
    }
    cleanup() {
        if (this.cleanupPromise) {
            return this.cleanupPromise;
        }
        this.listening = false;
        this.pushQueue.length = 0;
        this.cleanupPromise = this.unsubscribeAll();
        return this.cleanupPromise;
    }
    async unsubscribeAll() {
        if (!this.subscriptionPromise) {
            return;
        }
        let subscriptionIds;
        try {
            subscriptionIds = await this.subscriptionPromise;
        }
        catch {
            return;
        }
        await Promise.allSettled(subscriptionIds.map((subscriptionId) => this.pubSub.unsubscribe(subscriptionId)));
    }
    resolvePendingAsDone() {
        for (const pullRequest of this.pullQueue.splice(0)) {
            pullRequest.resolve({ value: undefined, done: true });
        }
    }
    rejectPending(error) {
        for (const pullRequest of this.pullQueue.splice(0)) {
            pullRequest.reject(error);
        }
    }
}
exports.SQSPubSubAsyncIterator = SQSPubSubAsyncIterator;
//# sourceMappingURL=async-iterator.js.map