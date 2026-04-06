/**
 * Signal - Observable state container with publish/subscribe pattern
 * ====================================================================
 *
 * A generic reactive state container that notifies subscribers when
 * the value changes. Supports both single-value and list-based signals.
 */

/** Callback type for signal subscribers */
export type SignalCallback<T> = (value: T) => void;

/**
 * Signal<T> - Observable state container
 *
 * Generic class that holds a value and notifies all subscribers
 * when the value is changed.
 */
export class Signal<T> {
  private value: T;
  private subscribers = new Set<SignalCallback<T>>();
  private unsubscribeFunctions = new Map<SignalCallback<T>, () => void>();

  constructor(initialValue: T) {
    this.value = initialValue;
  }

  /**
   * Get the current value.
   */
  get(): T {
    return this.value;
  }

  /**
   * Set a new value and notify all subscribers.
   */
  set(newValue: T): void {
    if (this.value === newValue) {
      return; // No change, don't notify
    }
    this.value = newValue;
    this.notify();
  }

  /**
   * Update the value using a transform function.
   */
  update(transform: (current: T) => T): void {
    this.set(transform(this.value));
  }

  /**
   * Subscribe to value changes.
   * @returns Unsubscribe function
   */
  subscribe(callback: SignalCallback<T>): () => void {
    this.subscribers.add(callback);

    const unsubscribe = () => {
      this.subscribers.delete(callback);
      this.unsubscribeFunctions.delete(callback);
    };

    this.unsubscribeFunctions.set(callback, unsubscribe);
    return unsubscribe;
  }

  /**
   * Unsubscribe a callback from value changes.
   */
  unsubscribe(callback: SignalCallback<T>): void {
    this.subscribers.delete(callback);
    this.unsubscribeFunctions.delete(callback);
  }

  /**
   * Get the number of subscribers.
   */
  get subscriberCount(): number {
    return this.subscribers.size;
  }

  /**
   * Notify all subscribers of the current value.
   */
  private notify(): void {
    for (const callback of this.subscribers) {
      try {
        callback(this.value);
      } catch (error) {
        console.error("[Signal] Subscriber threw error:", error);
      }
    }
  }

  /**
   * Destroy the signal and clear all subscribers.
   */
  destroy(): void {
    this.subscribers.clear();
    this.unsubscribeFunctions.clear();
  }
}

/**
 * SignalList<T> - Observable list container
 *
 * A signal that holds an array/list of items with methods for
 * adding, removing, and updating items while notifying subscribers.
 */
export class SignalList<T> {
  private signal: Signal<T[]>;
  private itemIds = new Map<string, T>();
  private idGenerator = 0;

  constructor(initialItems: T[] = []) {
    this.signal = new Signal<T[]>(initialItems);
    // Index items by generated ID
    for (const item of initialItems) {
      const id = `item_${this.idGenerator++}`;
      this.itemIds.set(id, item);
    }
  }

  /**
   * Get the current list of items.
   */
  get(): T[];
  /**
   * Get an item by ID.
   */
  get(id: string): T | undefined;
  /**
   * Implementation for both overloads.
   */
  get(id?: string): T[] | T | undefined {
    if (id === undefined) return this.signal.get();
    return this.itemIds.get(id);
  }

  /**
   * Set the entire list of items.
   */
  set(items: T[]): void {
    this.itemIds.clear();
    this.idGenerator = 0;
    for (const item of items) {
      const id = `item_${this.idGenerator++}`;
      this.itemIds.set(id, item);
    }
    this.signal.set(this.getList());
  }

  /**
   * Add an item to the list.
   */
  add(item: T): string {
    const id = `item_${this.idGenerator++}`;
    this.itemIds.set(id, item);
    this.signal.set(this.getList());
    return id;
  }

  /**
   * Remove an item by ID.
   */
  remove(id: string): boolean {
    const deleted = this.itemIds.delete(id);
    if (deleted) {
      this.signal.set(this.getList());
    }
    return deleted;
  }

  /**
   * Update an item by ID.
   */
  update(id: string, item: T): boolean {
    if (!this.itemIds.has(id)) {
      return false;
    }
    this.itemIds.set(id, item);
    this.signal.set(this.getList());
    return true;
  }

  /**
   * Get the current list as an array.
   */
  private getList(): T[] {
    return Array.from(this.itemIds.values());
  }

  /**
   * Subscribe to list changes.
   * @returns Unsubscribe function
   */
  subscribe(callback: SignalCallback<T[]>): () => void {
    return this.signal.subscribe(callback);
  }

  /**
   * Unsubscribe from list changes.
   */
  unsubscribe(callback: SignalCallback<T[]>): void {
    this.signal.unsubscribe(callback);
  }

  /**
   * Get the number of items.
   */
  get length(): number {
    return this.itemIds.size;
  }

  /**
   * Clear all items.
   */
  clear(): void {
    this.itemIds.clear();
    this.signal.set([]);
  }

  /**
   * Destroy the signal list.
   */
  destroy(): void {
    this.signal.destroy();
    this.itemIds.clear();
  }
}

/**
 * Create a signal with the given initial value.
 */
export function createSignal<T>(initialValue: T): Signal<T> {
  return new Signal<T>(initialValue);
}

/**
 * Create a signal list with optional initial items.
 */
export function createSignalList<T>(initialItems: T[] = []): SignalList<T> {
  return new SignalList<T>(initialItems);
}
