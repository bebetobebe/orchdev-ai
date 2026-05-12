import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from '../src/events';

describe('EventEmitter', () => {
    it('calls a subscribed listener on emit', () => {
        const emitter = new EventEmitter();
        const listener = vi.fn();
        emitter.subscribe(listener);

        emitter.emit();
        expect(listener).toHaveBeenCalledOnce();
    });

    it('calls multiple listeners in subscription order', () => {
        const emitter = new EventEmitter();
        const order: number[] = [];
        emitter.subscribe(() => order.push(1));
        emitter.subscribe(() => order.push(2));
        emitter.subscribe(() => order.push(3));

        emitter.emit();
        expect(order).toEqual([1, 2, 3]);
    });

    it('calls listeners on every emit', () => {
        const emitter = new EventEmitter();
        const listener = vi.fn();
        emitter.subscribe(listener);

        emitter.emit();
        emitter.emit();
        emitter.emit();
        expect(listener).toHaveBeenCalledTimes(3);
    });

    it('does nothing when emitting with no listeners', () => {
        const emitter = new EventEmitter();
        expect(() => emitter.emit()).not.toThrow();
    });

    it('unsubscribes a listener via the returned dispose function', () => {
        const emitter = new EventEmitter();
        const listener = vi.fn();
        const dispose = emitter.subscribe(listener);

        emitter.emit();
        expect(listener).toHaveBeenCalledOnce();

        dispose();
        emitter.emit();
        expect(listener).toHaveBeenCalledOnce(); // not called again
    });

    it('only removes the specific listener when dispose is called', () => {
        const emitter = new EventEmitter();
        const listenerA = vi.fn();
        const listenerB = vi.fn();

        const disposeA = emitter.subscribe(listenerA);
        emitter.subscribe(listenerB);

        disposeA();
        emitter.emit();

        expect(listenerA).not.toHaveBeenCalled();
        expect(listenerB).toHaveBeenCalledOnce();
    });

    it('is safe to call dispose multiple times', () => {
        const emitter = new EventEmitter();
        const listener = vi.fn();
        const dispose = emitter.subscribe(listener);

        dispose();
        dispose(); // second call should be harmless

        emitter.emit();
        expect(listener).not.toHaveBeenCalled();
    });
});
