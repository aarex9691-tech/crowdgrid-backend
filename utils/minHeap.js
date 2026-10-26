/**
 * Binary min-heap (priority queue), written by hand for the route finder.
 *
 * The items live in an array laid out as a complete binary tree:
 *   parent of i = (i - 1) >> 1, children of i = 2i + 1 and 2i + 2.
 * push and pop are O(log n): an item "bubbles up" or "sinks down" until its
 * parent is smaller and its children are bigger. peek is O(1).
 */
class MinHeap {
    constructor() {
        this.items = []; // [{ value, priority }]
    }

    get size() {
        return this.items.length;
    }

    isEmpty() {
        return this.items.length === 0;
    }

    peek() {
        return this.items[0]?.value;
    }

    push(value, priority) {
        const a = this.items;
        a.push({ value, priority });
        let i = a.length - 1;
        while (i > 0) {
            const parent = (i - 1) >> 1;
            if (a[parent].priority <= a[i].priority) break;
            [a[parent], a[i]] = [a[i], a[parent]];
            i = parent;
        }
    }

    /** Removes and returns { value, priority } with the smallest priority (undefined when empty). */
    pop() {
        const a = this.items;
        if (a.length === 0) return undefined;
        const top = a[0];
        const last = a.pop();
        if (a.length > 0) {
            a[0] = last;
            let i = 0;
            for (;;) {
                const l = 2 * i + 1;
                const r = l + 1;
                let smallest = i;
                if (l < a.length && a[l].priority < a[smallest].priority) smallest = l;
                if (r < a.length && a[r].priority < a[smallest].priority) smallest = r;
                if (smallest === i) break;
                [a[smallest], a[i]] = [a[i], a[smallest]];
                i = smallest;
            }
        }
        return top;
    }
}

module.exports = MinHeap;
