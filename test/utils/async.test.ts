/* eslint-disable no-magic-numbers */
/* eslint-disable @typescript-eslint/explicit-function-return-type */
/* eslint-disable prefer-arrow-callback */

import assert from "assert";
import * as async from "../../src/utils/async";
import { Uri } from "vscode";

suite("Async", () => {

    suite("cancelablePromise", function () {
        test("set token, don't wait for inner promise", function () {
            let canceled = 0;
            let promise = async.createCancelablePromise(token => {
                token.onCancellationRequested(_ => { canceled += 1; });
                return new Promise((_resolve) => { /* never */ });
            });
            let result = promise.then(_ => assert.ok(false), err => {
                assert.strictEqual(canceled, 1);
                assert.ok(async.isPromiseCanceledError(err));
            });
            promise.cancel();
            promise.cancel(); // cancel only once
            return result;
        });

        test("cancel despite inner promise being resolved", function () {
            let canceled = 0;
            let promise = async.createCancelablePromise(token => {
                token.onCancellationRequested(_ => { canceled += 1; });
                return Promise.resolve(1234);
            });
            let result = promise.then(_ => assert.ok(false), err => {
                assert.strictEqual(canceled, 1);
                assert.ok(async.isPromiseCanceledError(err));
            });
            promise.cancel();
            return result;
        });

        // Cancelling a sync cancelable promise will fire the cancelled token.
        // Also, every `then` callback runs in another execution frame.
        test("execution order (sync)", function () {
            const order: string[] = [];

            const cancellablePromise = async.createCancelablePromise(token => {
                order.push("in callback");
                token.onCancellationRequested(_ => order.push("cancelled"));
                return Promise.resolve(1234);
            });

            order.push("afterCreate");

            const promise = cancellablePromise
                .then(undefined, _err => null)
                .then(() => order.push("finally"));

            cancellablePromise.cancel();
            order.push("afterCancel");

            return promise.then(() => assert.deepStrictEqual(order, ["in callback", "afterCreate", "cancelled", "afterCancel", "finally"]));
        });

        // Cancelling an async cancelable promise is just the same as a sync cancellable promise.
        test("execution order (async)", function () {
            const order: string[] = [];

            const cancellablePromise = async.createCancelablePromise(token => {
                order.push("in callback");
                token.onCancellationRequested(_ => order.push("cancelled"));
                return new Promise(c => setTimeout(c.bind(1234), 0));
            });

            order.push("afterCreate");

            const promise = cancellablePromise
                .then(undefined, _err => null)
                .then(() => order.push("finally"));

            cancellablePromise.cancel();
            order.push("afterCancel");

            return promise.then(() => assert.deepStrictEqual(order, ["in callback", "afterCreate", "cancelled", "afterCancel", "finally"]));
        });

        test("get inner result", async function () {
            let promise = async.createCancelablePromise(_token => {
                return async.timeout(12).then(_ => 1234);
            });

            let result = await promise;
            assert.strictEqual(result, 1234);
        });
    });

    suite("Throttler", function () {
        test("non async", function () {
            let count = 0;
            let factory = () => {
                return Promise.resolve(++count);
            };

            let throttler = new async.Throttler();

            return Promise.all([
                throttler.queue(factory).then((result) => { assert.strictEqual(result, 1); }),
                throttler.queue(factory).then((result) => { assert.strictEqual(result, 2); }),
                throttler.queue(factory).then((result) => { assert.strictEqual(result, 2); }),
                throttler.queue(factory).then((result) => { assert.strictEqual(result, 2); }),
                throttler.queue(factory).then((result) => { assert.strictEqual(result, 2); })
            ]).then(() => assert.strictEqual(count, 2));
        });

        test("async", () => {
            let count = 0;
            let factory = () => async.timeout(0).then(() => ++count);

            let throttler = new async.Throttler();

            return Promise.all([
                throttler.queue(factory).then((result) => { assert.strictEqual(result, 1); }),
                throttler.queue(factory).then((result) => { assert.strictEqual(result, 2); }),
                throttler.queue(factory).then((result) => { assert.strictEqual(result, 2); }),
                throttler.queue(factory).then((result) => { assert.strictEqual(result, 2); }),
                throttler.queue(factory).then((result) => { assert.strictEqual(result, 2); })
            ]).then(() => {
                return Promise.all([
                    throttler.queue(factory).then((result) => { assert.strictEqual(result, 3); }),
                    throttler.queue(factory).then((result) => { assert.strictEqual(result, 4); }),
                    throttler.queue(factory).then((result) => { assert.strictEqual(result, 4); }),
                    throttler.queue(factory).then((result) => { assert.strictEqual(result, 4); }),
                    throttler.queue(factory).then((result) => { assert.strictEqual(result, 4); })
                ]);
            });
        });

        test("last factory should be the one getting called", function () {
            let factoryFactory = (n: number) => () => {
                return async.timeout(0).then(() => n);
            };

            let throttler = new async.Throttler();

            let promises: Promise<any>[] = [];

            promises.push(throttler.queue(factoryFactory(1)).then((n) => { assert.strictEqual(n, 1); }));
            promises.push(throttler.queue(factoryFactory(2)).then((n) => { assert.strictEqual(n, 3); }));
            promises.push(throttler.queue(factoryFactory(3)).then((n) => { assert.strictEqual(n, 3); }));

            return Promise.all(promises);
        });
    });

    suite("Delayer", function () {
        test("simple", () => {
            let count = 0;
            let factory = () => {
                return Promise.resolve(++count);
            };

            let delayer = new async.Delayer(0);
            let promises: Promise<any>[] = [];

            assert(!delayer.isTriggered());

            promises.push(delayer.trigger(factory).then((result) => { assert.strictEqual(result, 1); assert(!delayer.isTriggered()); }));
            assert(delayer.isTriggered());

            promises.push(delayer.trigger(factory).then((result) => { assert.strictEqual(result, 1); assert(!delayer.isTriggered()); }));
            assert(delayer.isTriggered());

            promises.push(delayer.trigger(factory).then((result) => { assert.strictEqual(result, 1); assert(!delayer.isTriggered()); }));
            assert(delayer.isTriggered());

            return Promise.all(promises).then(() => {
                assert(!delayer.isTriggered());
            });
        });

        test("microtask delay simple", () => {
            let count = 0;
            let factory = () => {
                return Promise.resolve(++count);
            };

            let delayer = new async.Delayer(async.MicrotaskDelay);
            let promises: Promise<any>[] = [];

            assert(!delayer.isTriggered());

            promises.push(delayer.trigger(factory).then((result) => { assert.strictEqual(result, 1); assert(!delayer.isTriggered()); }));
            assert(delayer.isTriggered());

            promises.push(delayer.trigger(factory).then((result) => { assert.strictEqual(result, 1); assert(!delayer.isTriggered()); }));
            assert(delayer.isTriggered());

            promises.push(delayer.trigger(factory).then((result) => { assert.strictEqual(result, 1); assert(!delayer.isTriggered()); }));
            assert(delayer.isTriggered());

            return Promise.all(promises).then(() => {
                assert(!delayer.isTriggered());
            });
        });

        suite("ThrottledDelayer", () => {
            test("promise should resolve if disposed", async () => {
                const throttledDelayer = new async.ThrottledDelayer<void>(100);
                const promise = throttledDelayer.trigger(async () => { }, 0);
                throttledDelayer.dispose();

                try {
                    await promise;
                    assert.fail("SHOULD NOT BE HERE");
                } catch (_err) {
                    // OK
                }
            });
        });

        test("simple cancel", function () {
            let count = 0;
            let factory = () => {
                return Promise.resolve(++count);
            };

            let delayer = new async.Delayer(0);

            assert(!delayer.isTriggered());

            const p = delayer.trigger(factory).then(() => {
                assert(false);
            }, () => {
                assert(true, "yes, it was cancelled");
            });

            assert(delayer.isTriggered());
            delayer.cancel();
            assert(!delayer.isTriggered());

            return p;
        });

        test("simple cancel microtask", function () {
            let count = 0;
            let factory = () => {
                return Promise.resolve(++count);
            };

            let delayer = new async.Delayer(async.MicrotaskDelay);

            assert(!delayer.isTriggered());

            const p = delayer.trigger(factory).then(() => {
                assert(false);
            }, () => {
                assert(true, "yes, it was cancelled");
            });

            assert(delayer.isTriggered());
            delayer.cancel();
            assert(!delayer.isTriggered());

            return p;
        });

        test("cancel should cancel all calls to trigger", function () {
            let count = 0;
            let factory = () => {
                return Promise.resolve(++count);
            };

            let delayer = new async.Delayer(0);
            let promises: Promise<any>[] = [];

            assert(!delayer.isTriggered());

            promises.push(delayer.trigger(factory).then(undefined, () => { assert(true, "yes, it was cancelled"); }));
            assert(delayer.isTriggered());

            promises.push(delayer.trigger(factory).then(undefined, () => { assert(true, "yes, it was cancelled"); }));
            assert(delayer.isTriggered());

            promises.push(delayer.trigger(factory).then(undefined, () => { assert(true, "yes, it was cancelled"); }));
            assert(delayer.isTriggered());

            delayer.cancel();

            return Promise.all(promises).then(() => {
                assert(!delayer.isTriggered());
            });
        });

        test("trigger, cancel, then trigger again", function () {
            let count = 0;
            let factory = () => {
                return Promise.resolve(++count);
            };

            let delayer = new async.Delayer(0);
            let promises: Promise<any>[] = [];

            assert(!delayer.isTriggered());

            const p = delayer.trigger(factory).then((result) => {
                assert.strictEqual(result, 1);
                assert(!delayer.isTriggered());

                promises.push(delayer.trigger(factory).then(undefined, () => { assert(true, "yes, it was cancelled"); }));
                assert(delayer.isTriggered());

                promises.push(delayer.trigger(factory).then(undefined, () => { assert(true, "yes, it was cancelled"); }));
                assert(delayer.isTriggered());

                delayer.cancel();

                const p = Promise.all(promises).then(() => {
                    promises = [];

                    assert(!delayer.isTriggered());

                    promises.push(delayer.trigger(factory).then(() => { assert.strictEqual(result, 1); assert(!delayer.isTriggered()); }));
                    assert(delayer.isTriggered());

                    promises.push(delayer.trigger(factory).then(() => { assert.strictEqual(result, 1); assert(!delayer.isTriggered()); }));
                    assert(delayer.isTriggered());

                    const p = Promise.all(promises).then(() => {
                        assert(!delayer.isTriggered());
                    });

                    assert(delayer.isTriggered());

                    return p;
                });

                return p;
            });

            assert(delayer.isTriggered());

            return p;
        });

        test("last task should be the one getting called", function () {
            let factoryFactory = (n: number) => () => {
                return Promise.resolve(n);
            };

            let delayer = new async.Delayer(0);
            let promises: Promise<any>[] = [];

            assert(!delayer.isTriggered());

            promises.push(delayer.trigger(factoryFactory(1)).then((n) => { assert.strictEqual(n, 3); }));
            promises.push(delayer.trigger(factoryFactory(2)).then((n) => { assert.strictEqual(n, 3); }));
            promises.push(delayer.trigger(factoryFactory(3)).then((n) => { assert.strictEqual(n, 3); }));

            const p = Promise.all(promises).then(() => {
                assert(!delayer.isTriggered());
            });

            assert(delayer.isTriggered());

            return p;
        });
    });

    suite("sequence", () => {
        test("simple", () => {
            let factoryFactory = (n: number) => () => {
                return Promise.resolve(n);
            };

            return async.sequence([
                factoryFactory(1),
                factoryFactory(2),
                factoryFactory(3),
                factoryFactory(4),
                factoryFactory(5),
            ]).then((result) => {
                assert.strictEqual(5, result.length);
                assert.strictEqual(1, result[0]);
                assert.strictEqual(2, result[1]);
                assert.strictEqual(3, result[2]);
                assert.strictEqual(4, result[3]);
                assert.strictEqual(5, result[4]);
            });
        });
    });

    suite("Limiter", () => {
        test("sync", function () {
            let factoryFactory = (n: number) => () => {
                return Promise.resolve(n);
            };

            let limiter = new async.Limiter(1);

            let promises: Promise<any>[] = [];
            [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].forEach(n => promises.push(limiter.queue(factoryFactory(n))));

            return Promise.all(promises).then((res) => {
                assert.strictEqual(10, res.length);

                limiter = new async.Limiter(100);

                promises = [];
                [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].forEach(n => promises.push(limiter.queue(factoryFactory(n))));

                return Promise.all(promises).then((res) => {
                    assert.strictEqual(10, res.length);
                });
            });
        });

        test("async", function () {
            let factoryFactory = (n: number) => () => async.timeout(0).then(() => n);

            let limiter = new async.Limiter(1);
            let promises: Promise<any>[] = [];
            [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].forEach(n => promises.push(limiter.queue(factoryFactory(n))));

            return Promise.all(promises).then((res) => {
                assert.strictEqual(10, res.length);

                limiter = new async.Limiter(100);

                promises = [];
                [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].forEach(n => promises.push(limiter.queue(factoryFactory(n))));

                return Promise.all(promises).then((res) => {
                    assert.strictEqual(10, res.length);
                });
            });
        });

        test("assert degree of paralellism", function () {
            let activePromises = 0;
            let factoryFactory = (n: number) => () => {
                activePromises++;
                assert(activePromises < 6);
                return async.timeout(0).then(() => { activePromises--; return n; });
            };

            let limiter = new async.Limiter(5);

            let promises: Promise<any>[] = [];
            [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].forEach(n => promises.push(limiter.queue(factoryFactory(n))));

            return Promise.all(promises).then((res) => {
                assert.strictEqual(10, res.length);
                assert.deepStrictEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], res);
            });
        });
    });

    suite("Queue", () => {
        test("simple", function () {
            let queue = new async.Queue();

            let syncPromise = false;
            let f1 = () => Promise.resolve(true).then(() => syncPromise = true);

            let asyncPromise = false;
            let f2 = () => async.timeout(10).then(() => asyncPromise = true);

            assert.strictEqual(queue.size, 0);

            queue.queue(f1);
            assert.strictEqual(queue.size, 1);

            const p = queue.queue(f2);
            assert.strictEqual(queue.size, 2);
            return p.then(() => {
                assert.strictEqual(queue.size, 0);
                assert.ok(syncPromise);
                assert.ok(asyncPromise);
            });
        });

        test("order is kept", function () {
            let queue = new async.Queue();

            let res: number[] = [];

            let f1 = () => Promise.resolve(true).then(() => res.push(1));
            let f2 = () => async.timeout(10).then(() => res.push(2));
            let f3 = () => Promise.resolve(true).then(() => res.push(3));
            let f4 = () => async.timeout(20).then(() => res.push(4));
            let f5 = () => async.timeout(0).then(() => res.push(5));

            queue.queue(f1);
            queue.queue(f2);
            queue.queue(f3);
            queue.queue(f4);
            return queue.queue(f5).then(() => {
                assert.strictEqual(res[0], 1);
                assert.strictEqual(res[1], 2);
                assert.strictEqual(res[2], 3);
                assert.strictEqual(res[3], 4);
                assert.strictEqual(res[4], 5);
            });
        });

        test("errors bubble individually but not cause stop", function () {
            let queue = new async.Queue();

            let res: number[] = [];
            let error = false;

            let f1 = () => Promise.resolve(true).then(() => res.push(1));
            let f2 = () => async.timeout(10).then(() => res.push(2));
            let f3 = () => Promise.resolve(true).then(() => Promise.reject(new Error("error")));
            let f4 = () => async.timeout(20).then(() => res.push(4));
            let f5 = () => async.timeout(0).then(() => res.push(5));

            queue.queue(f1);
            queue.queue(f2);
            queue.queue(f3).then(undefined, () => error = true);
            queue.queue(f4);
            return queue.queue(f5).then(() => {
                assert.strictEqual(res[0], 1);
                assert.strictEqual(res[1], 2);
                assert.ok(error);
                assert.strictEqual(res[2], 4);
                assert.strictEqual(res[3], 5);
            });
        });

        test("order is kept (chained)", function () {
            let queue = new async.Queue();

            let res: number[] = [];

            let f1 = () => Promise.resolve(true).then(() => res.push(1));
            let f2 = () => async.timeout(10).then(() => res.push(2));
            let f3 = () => Promise.resolve(true).then(() => res.push(3));
            let f4 = () => async.timeout(20).then(() => res.push(4));
            let f5 = () => async.timeout(0).then(() => res.push(5));

            return queue.queue(f1).then(() => {
                return queue.queue(f2).then(() => {
                    return queue.queue(f3).then(() => {
                        return queue.queue(f4).then(() => {
                            return queue.queue(f5).then(() => {
                                assert.strictEqual(res[0], 1);
                                assert.strictEqual(res[1], 2);
                                assert.strictEqual(res[2], 3);
                                assert.strictEqual(res[3], 4);
                                assert.strictEqual(res[4], 5);
                            });
                        });
                    });
                });
            });
        });

        test("events", async function () {
            let queue = new async.Queue();

            let finished = false;
            const onFinished = async.Event.toPromise(queue.onFinished).then(() => finished = true);

            let res: number[] = [];

            let f1 = () => async.timeout(10).then(() => res.push(2));
            let f2 = () => async.timeout(20).then(() => res.push(4));
            let f3 = () => async.timeout(0).then(() => res.push(5));

            const q1 = queue.queue(f1);
            const q2 = queue.queue(f2);
            queue.queue(f3);

            q1.then(() => {
                assert.ok(!finished);
                q2.then(() => {
                    assert.ok(!finished);
                });
            });

            await onFinished;
            assert.ok(finished);
        });
    });

    suite("ResourceQueue", () => {
        test("simple", async function () {
            let queue = new async.ResourceQueue();

            await queue.whenDrained(); // returns immediately since empty

            const r1Queue = queue.queueFor(Uri.file("/some/path"));

            await queue.whenDrained(); // returns immediately since empty

            const r2Queue = queue.queueFor(Uri.file("/some/other/path"));

            await queue.whenDrained(); // returns immediately since empty

            assert.ok(r1Queue);
            assert.ok(r2Queue);
            assert.strictEqual(r1Queue, queue.queueFor(Uri.file("/some/path"))); // same queue returned

            // schedule some work
            const w1 = new async.DeferredPromise<void>();
            r1Queue.queue(() => w1.p);

            let drained = false;
            queue.whenDrained().then(() => drained = true);
            assert.strictEqual(drained, false);
            await w1.complete();
            await async.timeout(0);
            assert.strictEqual(drained, true);

            const r1Queue2 = queue.queueFor(Uri.file("/some/path"));
            assert.notStrictEqual(r1Queue, r1Queue2); // previous one got disposed after finishing

            // schedule some work
            const w2 = new async.DeferredPromise<void>();
            const w3 = new async.DeferredPromise<void>();
            r1Queue.queue(() => w2.p);
            r2Queue.queue(() => w3.p);

            drained = false;
            queue.whenDrained().then(() => drained = true);

            queue.dispose();
            await async.timeout(0);
            assert.strictEqual(drained, true);
        });
    });

    suite("retry", () => {
        test("success case", async () => {
            let counter = 0;

            const res = await async.retry(() => {
                counter++;
                if (counter < 2) {
                    return Promise.reject(new Error("fail"));
                }

                return Promise.resolve(true);
            }, 10, 3);

            assert.strictEqual(res, true);
        });

        test("error case", async () => {
            let expectedError = new Error("fail");
            try {
                await async.retry(() => {
                    return Promise.reject(expectedError);
                }, 10, 3);
            } catch (error) {
                assert.strictEqual(error, error);
            }
        });
    });

    suite("TaskSequentializer", () => {
        // pending basics

        test("pending and next (finishes instantly)", async function () {
            const sequentializer = new async.TaskSequentializer();

            let pendingDone = false;
            sequentializer.setPending(1, async.timeout(1).then(() => { pendingDone = true; return; }));

            // next finishes instantly
            let nextDone = false;
            const res = sequentializer.setNext(() => Promise.resolve(null).then(() => { nextDone = true; return; }));

            await res;
            assert.ok(pendingDone);
            assert.ok(nextDone);
        });

        test("pending and next (finishes after timeout)", async function () {
            const sequentializer = new async.TaskSequentializer();

            let pendingDone = false;
            sequentializer.setPending(1, async.timeout(1).then(() => { pendingDone = true; return; }));

            // next finishes after async.timeout
            let nextDone = false;
            const res = sequentializer.setNext(() => async.timeout(1).then(() => { nextDone = true; return; }));

            await res;
            assert.ok(pendingDone);
            assert.ok(nextDone);
        });

        test("pending and multiple next (last one wins)", async function () {
            const sequentializer = new async.TaskSequentializer();

            let pendingDone = false;
            sequentializer.setPending(1, async.timeout(1).then(() => { pendingDone = true; return; }));

            // next finishes after async.timeout
            let firstDone = false;
            let firstRes = sequentializer.setNext(() => async.timeout(2).then(() => { firstDone = true; return; }));

            let secondDone = false;
            let secondRes = sequentializer.setNext(() => async.timeout(3).then(() => { secondDone = true; return; }));

            let thirdDone = false;
            let thirdRes = sequentializer.setNext(() => async.timeout(4).then(() => { thirdDone = true; return; }));

            await Promise.all([firstRes, secondRes, thirdRes]);
            assert.ok(pendingDone);
            assert.ok(!firstDone);
            assert.ok(!secondDone);
            assert.ok(thirdDone);
        });

        test("cancel pending", async function () {
            const sequentializer = new async.TaskSequentializer();

            let pendingCancelled = false;
            sequentializer.setPending(1, async.timeout(1), () => pendingCancelled = true);
            sequentializer.cancelPending();

            assert.ok(pendingCancelled);
        });
    });

    // raceCancellation

    // raceTimeout

    // SequencerByKey

    // IntervalCounter

    // firstParallel

    // DeferredPromise

    // Promises.settled

    // Promises.withAsyncBody

    // ThrottledWorker
});
