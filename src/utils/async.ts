/*
    From https://github.com/Microsoft/vscode/blob/master/src/vs/base/common/async.ts circa https://github.com/Microsoft/vscode/commit/aba7b7c3bc50f8de9d2d500b6ece2aa8a19dd55b#diff-7f75742c446886007f8cb709c1ca2eff
*/

import { CancellationToken, Event, EventEmitter, Disposable, Uri, CancellationTokenSource } from "vscode";

const canceledName = "Canceled";
/**
 * Returns an error that signals cancellation.
 */
export function canceled(): Error {
    let error = new Error(canceledName);
    error.name = error.message;
    return error;
}
/**
 * Checks if the given error is a promise in canceled state
 */
export function isPromiseCanceledError(error: any): boolean {
    return error instanceof Error && error.name === canceledName && error.message === canceledName;
}

export function isThenable<T>(obj: any): obj is Promise<T> {
    return obj && typeof (<Promise<any>>obj).then === "function";
}

export interface CancelablePromise<T> extends Promise<T> {
    cancel(): void;
}

export function createCancelablePromise<T>(callback: (token: CancellationToken) => Promise<T>): CancelablePromise<T> {
    const source = new CancellationTokenSource();

    const thenable = callback(source.token);
    const promise = new Promise<T>((resolve, reject) => {
        source.token.onCancellationRequested(() => {
            reject(canceled());
        });
        Promise.resolve(thenable).then((value) => {
            source.dispose();
            resolve(value);
        }, (err) => {
            source.dispose();
            reject(err);
        });
    });

    return new class implements CancelablePromise<T> {
        readonly [Symbol.toStringTag] = "promise";
        cancel() {
            source.cancel();
        }
        then<TResult1 = T, TResult2 = never>(resolve?: ((value: T) => TResult1 | Promise<TResult1>) | undefined | null, reject?: ((reason: any) => TResult2 | Promise<TResult2>) | undefined | null): Promise<TResult1 | TResult2> {
            return promise.then(resolve, reject);
        }
        catch<TResult = never>(reject?: ((reason: any) => TResult | Promise<TResult>) | undefined | null): Promise<T | TResult> {
            return this.then(undefined, reject);
        }
        finally(onfinally?: (() => void) | undefined | null): Promise<T> {
            return always(promise, onfinally || (() => { }));
        }
    };
}

export function asPromise<T>(callback: () => T | Thenable<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        let item = callback();
        if (isThenable<T>(item)) {
            item.then(resolve, reject);
        } else {
            resolve(item);
        }
    });
}

export interface ITask<T> {
    (): T;
}

interface IDisposable {
    /**
     * Dispose and free associated resources.
     */
    dispose(): void;
}

function toDisposable(fn: () => void): IDisposable {
    return { dispose() { fn(); } };
}

/**
 * A helper to prevent accumulation of sequential async tasks.
 *
 * Imagine a mail man with the sole task of delivering letters. As soon as
 * a letter submitted for delivery, he drives to the destination, delivers it
 * and returns to his base. Imagine that during the trip, N more letters were submitted.
 * When the mail man returns, he picks those N letters and delivers them all in a
 * single trip. Even though N+1 submissions occurred, only 2 deliveries were made.
 *
 * The throttler implements this via the queue() method, by providing it a task
 * factory. Following the example:
 *      ```typescript
 *      const throttler = new Throttler();
 *      const letters = [];
 *
 *      function deliver() {
 *          const lettersToDeliver = letters;
 *          letters = [];
 *          return makeTheTrip(lettersToDeliver);
 *      }
 *
 *      function onLetterReceived(l) {
 *          letters.push(l);
 *          throttler.queue(deliver);
 *      }
 *      ```
 */
export class Throttler<T> {

    private activePromise: Promise<T> | null;
    private queuedPromise: Promise<T> | null;
    private queuedPromiseFactory: ITask<Promise<T>> | null;

    constructor() {
        this.activePromise = null;
        this.queuedPromise = null;
        this.queuedPromiseFactory = null;
    }

    public queue(promiseFactory: ITask<Promise<T>>): Promise<T> {
        if (this.activePromise) {
            this.queuedPromiseFactory = promiseFactory;

            if (!this.queuedPromise) {
                const onComplete = () => {
                    this.queuedPromise = null;

                    const result = this.queue(this.queuedPromiseFactory!);
                    this.queuedPromiseFactory = null;

                    return result;
                };

                this.queuedPromise = new Promise<T>((resolve) => {
                    this.activePromise!.then(onComplete, onComplete).then(resolve);
                });
            }

            return new Promise<T>((resolve, reject) => {
                this.queuedPromise!.then(resolve, reject);
            });
        }

        this.activePromise = promiseFactory();

        return new Promise<T>((resolve, reject) => {
            this.activePromise!.then((result: T) => {
                this.activePromise = null;
                resolve(result);
            }, (err: any) => {
                this.activePromise = null;
                reject(err);
            });
        });
    }
}

export class Sequencer {

    private current: Promise<any> = Promise.resolve(null);

    queue<T>(promiseTask: ITask<Promise<T>>): Promise<T> {
        return this.current = this.current.then(() => promiseTask());
    }
}

/**
 * A helper to delay execution of a task that is being requested often.
 *
 * Following the throttler, now imagine the mail man wants to optimize the number of
 * trips proactively. The trip itself can be long, so he decides not to make the trip
 * as soon as a letter is submitted. Instead he waits a while, in case more
 * letters are submitted. After said waiting period, if no letters were submitted, he
 * decides to make the trip. Imagine that N more letters were submitted after the first
 * one, all within a short period of time between each other. Even though N+1
 * submissions occurred, only 1 delivery was made.
 *
 * The delayer offers this behavior via the trigger() method, into which both the task
 * to be executed and the waiting period (delay) must be passed in as arguments. Following
 * the example:
 *      ```typescript
 *      const delayer = new Delayer(WAITING_PERIOD);
 *      const letters = [];
 *
 *      function letterReceived(l) {
 *          letters.push(l);
 *          delayer.trigger(() => { return makeTheTrip(); });
 *      }
 *      ```
 */
export class Delayer<T> implements IDisposable {

    private timeout: NodeJS.Timer | null;
    private completionPromise: Promise<T> | null;
    // also referred to as onResolve or onSuccess
    private doResolve: ((value: T | Promise<T> | undefined) => void) | null;
    private doReject: (err: any) => void;
    private task: ITask<T | Promise<T>> | null;

    constructor(public defaultDelay: number) {
        this.timeout = null;
        this.completionPromise = null;
        this.doResolve = null;
        this.task = null;
    }

    public trigger(task: ITask<T | Promise<T>>, delay: number = this.defaultDelay): Promise<T> {
        this.task = task;
        this.cancelTimeout();

        if (!this.completionPromise) {
            this.completionPromise = new Promise<T>((resolve, reject) => {
                this.doResolve = resolve;
                this.doReject = reject;
            }).then(() => {
                this.completionPromise = null;
                this.doResolve = null;
                const task = this.task!;
                this.task = null;

                return task();
            });
        }

        this.timeout = setTimeout(() => {
            this.timeout = null;
            this.doResolve!(undefined);
        }, delay);

        return this.completionPromise;
    }

    public forceDelivery(): Promise<T> | null {
        if (!this.completionPromise) {
            return null;
        }
        this.cancelTimeout();
        let result = this.completionPromise;
        this.doResolve!(undefined);
        return result;
    }

    public isTriggered(): boolean {
        return this.timeout !== null;
    }

    public cancel(): void {
        this.cancelTimeout();

        if (this.completionPromise) {
            this.doReject(canceled());
            this.completionPromise = null;
        }
    }

    private cancelTimeout(): void {
        if (this.timeout !== null) {
            clearTimeout(this.timeout);
            this.timeout = null;
        }
    }

    dispose(): void {
        this.cancelTimeout();
    }
}

/**
 * A helper to delay execution of a task that is being requested often, while
 * preventing accumulation of consecutive executions, while the task runs.
 *
 * The mail man is clever and waits for a certain amount of time, before going
 * out to deliver letters. While the mail man is going out, more letters arrive
 * and can only be delivered once he is back. Once he is back the mail man will
 * do one more trip to deliver the letters that have accumulated while he was out.
 */
export class ThrottledDelayer<T> extends Delayer<Promise<T>> {

    private throttler: Throttler<T>;

    constructor(defaultDelay: number) {
        super(defaultDelay);
        this.throttler = new Throttler<T>();
    }

    public trigger(promiseFactory: ITask<Promise<T>>, delay?: number): Promise<Promise<T>> {
        return super.trigger(() => this.throttler.queue(promiseFactory), delay);
    }
}

/**
 * A barrier that is initially closed and then becomes opened permanently.
 */
export class Barrier {

    private _isOpen: boolean;
    private _promise: Promise<boolean>;
    private _completePromise: (v: boolean) => void;

    constructor() {
        this._isOpen = false;
        this._promise = new Promise<boolean>((resolve) => {
            this._completePromise = resolve;
        });
    }

    isOpen(): boolean {
        return this._isOpen;
    }

    open(): void {
        this._isOpen = true;
        this._completePromise(true);
    }

    wait(): Promise<boolean> {
        return this._promise;
    }
}

export function timeout(millis: number): CancelablePromise<void>;
export function timeout(millis: number, token: CancellationToken): Promise<void>;
export function timeout(millis: number, token?: CancellationToken): CancelablePromise<void> | Promise<void> {
    if (!token) {
        return createCancelablePromise((token) => timeout(millis, token));
    }

    return new Promise((resolve, reject) => {
        const handle = setTimeout(resolve, millis);
        token.onCancellationRequested(() => {
            clearTimeout(handle);
            reject(canceled());
        });
    });
}

export function disposableTimeout(handler: () => void, timeout = 0): IDisposable {
    const timer = setTimeout(handler, timeout);
    return toDisposable(() => clearTimeout(timer));
}

/**
 * Returns a new promise that joins the provided promise. Upon completion of
 * the provided promise the provided function will always be called. This
 * method is comparable to a try-finally code block.
 * @param promise a promise
 * @param callback a function that will be call in the success and error case.
 */
export function always<T>(promise: Promise<T>, callback: () => void): Promise<T> {
    function safeCallback() {
        try {
            callback();
        } catch (err) {
            console.error(err);
        }
    }
    promise.then((_) => safeCallback(), (_) => safeCallback());
    return Promise.resolve(promise);
}

export function ignoreErrors<T>(promise: Promise<T>): Promise<T | undefined> {
    return promise.then(undefined, (_) => undefined);
}

/**
 * Runs the provided list of promise factories in sequential order. The returned
 * promise will complete to an array of results from each promise.
 */

export async function sequence<T>(promiseFactories: ITask<Promise<T>>[]): Promise<T[]> {
    const results: T[] = [];
    let index = 0;
    const len = promiseFactories.length;

    function next(): Promise<T> | null {
        return index < len ? promiseFactories[index++]() : null;
    }

    function thenHandler(result: any): Promise<any> {
        if (result !== undefined && result !== null) {
            results.push(result);
        }

        const n = next();
        if (n) {
            return n.then(thenHandler);
        }

        return Promise.resolve(results);
    }

    return thenHandler(await Promise.resolve(null));
}

export function first<T>(promiseFactories: ITask<Promise<T>>[], shouldStop: (t: T) => boolean = (t) => !!t, defaultValue: T | null = null): Promise<T | null> {
    let index = 0;
    const len = promiseFactories.length;

    const loop: () => Promise<T | null> = async () => {
        if (index >= len) {
            return Promise.resolve(defaultValue);
        }

        const factory = promiseFactories[index++];
        const promise = Promise.resolve(factory());

        const result = await promise;
        if (shouldStop(result)) {
            return Promise.resolve(result);
        }
        return loop();
    };

    return loop();
}

interface ILimitedTaskFactory<T> {
    factory: ITask<Promise<T>>;
    c: (value?: T | Promise<T>) => void;
    e: (error?: any) => void;
}

/**
 * A helper to queue N promises and run them all with a max degree of parallelism. The helper
 * ensures that at any time no more than M promises are running at the same time.
 */
export class Limiter<T> {

    private _size = 0;
    private runningPromises: number;
    private maxDegreeOfParalellism: number;
    private outstandingPromises: ILimitedTaskFactory<T>[];
    private readonly _onFinished: EventEmitter<void>;

    constructor(maxDegreeOfParalellism: number) {
        this.maxDegreeOfParalellism = maxDegreeOfParalellism;
        this.outstandingPromises = [];
        this.runningPromises = 0;
        this._onFinished = new EventEmitter<void>();
    }

    public get onFinished(): Event<void> {
        return this._onFinished.event;
    }

    public get size(): number {
        return this._size;
        // return this.runningPromises + this.outstandingPromises.length;
    }

    queue(factory: ITask<Promise<T>>): Promise<T> {
        this._size++;

        return new Promise<T>((resolve, reject) => {
            this.outstandingPromises.push({ factory, c: resolve, e: reject });
            this.consume();
        });
    }

    private consume(): void {
        while (this.outstandingPromises.length && this.runningPromises < this.maxDegreeOfParalellism) {
            const iLimitedTask = this.outstandingPromises.shift()!;
            this.runningPromises++;

            const promise = iLimitedTask.factory();
            promise.then(iLimitedTask.c, iLimitedTask.e);
            promise.then(() => this.consumed(), () => this.consumed());
        }
    }

    private consumed(): void {
        this._size--;
        this.runningPromises--;

        if (this.outstandingPromises.length > 0) {
            this.consume();
        } else {
            this._onFinished.fire();
        }
    }

    public dispose(): void {
        this._onFinished.dispose();
    }
}

/**
 * A queue handles one promise at a time and guarantees that at any time only one promise is executing.
 */
export class Queue<T> extends Limiter<T> {

    constructor() {
        super(1);
    }
}

/**
 * A helper to organize queues per resource. The ResourceQueue makes sure to manage queues per resource
 * by disposing them once the queue is empty.
 */
export class ResourceQueue {
    private queues: { [path: string]: Queue<void> };

    constructor() {
        this.queues = Object.create(null);
    }

    public queueFor(resource: Uri): Queue<void> {
        const key = resource.toString();
        if (!this.queues[key]) {
            const queue = new Queue<void>();
            queue.onFinished(() => {
                queue.dispose();
                delete this.queues[key];
            });

            this.queues[key] = queue;
        }

        return this.queues[key];
    }
}

export class TimeoutTimer extends Disposable {
    private _token: any;

    constructor();
    constructor(runner: () => void, timeout: number);
    constructor(runner?: () => void, timeout?: number) {
        super(() => { });
        this._token = -1;

        if (typeof runner === "function" && typeof timeout === "number") {
            this.setIfNotSet(runner, timeout);
        }
    }

    dispose(): void {
        this.cancel();
        super.dispose();
    }

    cancel(): void {
        if (this._token !== -1) {
            clearTimeout(this._token);
            this._token = -1;
        }
    }

    cancelAndSet(runner: () => void, timeout: number): void {
        this.cancel();
        this._token = setTimeout(() => {
            this._token = -1;
            runner();
        }, timeout);
    }

    setIfNotSet(runner: () => void, timeout: number): void {
        if (this._token !== -1) {
            // timer is already set
            return;
        }
        this._token = setTimeout(() => {
            this._token = -1;
            runner();
        }, timeout);
    }
}

export class IntervalTimer extends Disposable {

    private _token: any;

    constructor() {
        super(() => { });
        this._token = -1;
    }

    dispose(): void {
        this.cancel();
        super.dispose();
    }

    cancel(): void {
        if (this._token !== -1) {
            clearInterval(this._token);
            this._token = -1;
        }
    }

    cancelAndSet(runner: () => void, interval: number): void {
        this.cancel();
        this._token = setInterval(() => {
            runner();
        }, interval);
    }
}

export class RunOnceScheduler {

    protected runner: ((...args: any[]) => void) | null;

    private timeoutToken: any;
    private timeout: number;
    private timeoutHandler: () => void;

    constructor(runner: (...args: any[]) => void, timeout: number) {
        this.timeoutToken = -1;
        this.runner = runner;
        this.timeout = timeout;
        this.timeoutHandler = this.onTimeout.bind(this);
    }

    /**
     * Dispose RunOnceScheduler
     */
    dispose(): void {
        this.cancel();
        this.runner = null;
    }

    /**
     * Cancel current scheduled runner (if any).
     */
    cancel(): void {
        if (this.isScheduled()) {
            clearTimeout(this.timeoutToken);
            this.timeoutToken = -1;
        }
    }

    /**
     * Cancel previous runner (if any) & schedule a new runner.
     */
    schedule(delay = this.timeout): void {
        this.cancel();
        this.timeoutToken = setTimeout(this.timeoutHandler, delay);
    }

    /**
     * Returns true if scheduled.
     */
    isScheduled(): boolean {
        return this.timeoutToken !== -1;
    }

    private onTimeout() {
        this.timeoutToken = -1;
        if (this.runner) {
            this.doRun();
        }
    }

    protected doRun(): void {
        if (this.runner) {
            this.runner();
        }
    }
}

export class RunOnceWorker<T> extends RunOnceScheduler {
    private units: T[] = [];

    constructor(runner: (units: T[]) => void, timeout: number) {
        super(runner, timeout);
    }

    work(unit: T): void {
        this.units.push(unit);

        if (!this.isScheduled()) {
            this.schedule();
        }
    }

    protected doRun(): void {
        const units = this.units;
        this.units = [];

        if (this.runner) {
            this.runner(units);
        }
    }

    dispose(): void {
        this.units = [];

        super.dispose();
    }
}

export function nfcall(fn: Function, ...args: any[]): Promise<any>;
export function nfcall<T>(fn: Function, ...args: any[]): Promise<T>;
export function nfcall(fn: Function, ...args: any[]): any {
    return new Promise((c, e) => fn(...args, (err: any, result: any) => err ? e(err) : c(result)));
}

export function ninvoke(thisArg: any, fn: Function, ...args: any[]): Promise<any>;
export function ninvoke<T>(thisArg: any, fn: Function, ...args: any[]): Promise<T>;
export function ninvoke(thisArg: any, fn: Function, ...args: any[]): any {
    return new Promise((resolve, reject) => fn.call(thisArg, ...args, (err: any, result: any) => err ? reject(err) : resolve(result)));
}
