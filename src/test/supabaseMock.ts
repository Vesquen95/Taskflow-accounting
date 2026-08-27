import { vi } from 'vitest'

/**
 * A minimal, generic stand-in for the chainable Supabase query builder
 * (`supabase.from(table).select().eq().order()...`) used throughout the
 * app. It never touches the network — every terminal call (`await`ing the
 * chain, or calling `.single()`) is resolved by a per-table handler
 * function that the test supplies, so tests stay fast and deterministic.
 *
 * Usage:
 *   const handlers: SupabaseHandlers = {
 *     boards: () => ({ data: [{ id: 'b1', ... }], error: null }),
 *   }
 *   const supabase = createSupabaseMock(handlers)
 */

export interface ChainState {
  table: string
  op: 'select' | 'insert' | 'update' | 'delete'
  payload?: unknown
  /** Ordered record of every filter/modifier call made on the chain. */
  calls: Array<{ method: string; args: unknown[] }>
}

type HandlerResult = { data: unknown; error: unknown }
type Handler = (state: ChainState) => HandlerResult | Promise<HandlerResult>

export type SupabaseHandlers = Record<string, Handler>

function missingHandlerResult(table: string): HandlerResult {
  return {
    data: null,
    error: new Error(`[supabaseMock] no handler configured for table "${table}"`),
  }
}

function createQueryBuilder(handlers: SupabaseHandlers, table: string) {
  const state: ChainState = { table, op: 'select', calls: [] }

  function resolve(): Promise<HandlerResult> {
    const handler = handlers[table]
    if (!handler) return Promise.resolve(missingHandlerResult(table))
    return Promise.resolve(handler(state))
  }

  const builder: PromiseLike<HandlerResult> & Record<string, unknown> = {
    select: vi.fn((...args: unknown[]) => {
      // select() after insert/update/delete just asks for the row(s) back;
      // it doesn't change which handler applies, so op is left as-is.
      state.calls.push({ method: 'select', args })
      return builder
    }),
    insert: vi.fn((payload: unknown) => {
      state.op = 'insert'
      state.payload = payload
      state.calls.push({ method: 'insert', args: [payload] })
      return builder
    }),
    update: vi.fn((payload: unknown) => {
      state.op = 'update'
      state.payload = payload
      state.calls.push({ method: 'update', args: [payload] })
      return builder
    }),
    delete: vi.fn((...args: unknown[]) => {
      state.op = 'delete'
      state.calls.push({ method: 'delete', args })
      return builder
    }),
    eq: vi.fn((...args: unknown[]) => {
      state.calls.push({ method: 'eq', args })
      return builder
    }),
    neq: vi.fn((...args: unknown[]) => {
      state.calls.push({ method: 'neq', args })
      return builder
    }),
    in: vi.fn((...args: unknown[]) => {
      state.calls.push({ method: 'in', args })
      return builder
    }),
    lt: vi.fn((...args: unknown[]) => {
      state.calls.push({ method: 'lt', args })
      return builder
    }),
    lte: vi.fn((...args: unknown[]) => {
      state.calls.push({ method: 'lte', args })
      return builder
    }),
    gt: vi.fn((...args: unknown[]) => {
      state.calls.push({ method: 'gt', args })
      return builder
    }),
    gte: vi.fn((...args: unknown[]) => {
      state.calls.push({ method: 'gte', args })
      return builder
    }),
    is: vi.fn((...args: unknown[]) => {
      state.calls.push({ method: 'is', args })
      return builder
    }),
    or: vi.fn((...args: unknown[]) => {
      state.calls.push({ method: 'or', args })
      return builder
    }),
    order: vi.fn((...args: unknown[]) => {
      state.calls.push({ method: 'order', args })
      return builder
    }),
    limit: vi.fn((...args: unknown[]) => {
      state.calls.push({ method: 'limit', args })
      return builder
    }),
    single: vi.fn(() => resolve()),
    maybeSingle: vi.fn(() => resolve()),
    // Makes `await builder` work without an explicit `.single()` call.
    then: <TResult1 = HandlerResult, TResult2 = never>(
      onFulfilled?: ((value: HandlerResult) => TResult1 | PromiseLike<TResult1>) | null,
      onRejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
    ) => resolve().then(onFulfilled ?? undefined, onRejected ?? undefined),
  }

  return builder
}

export type RpcHandler = (fnName: string, args: unknown) => HandlerResult | Promise<HandlerResult>

export interface SupabaseAuthOverrides {
  getSession?: () => Promise<{ data: { session: unknown } }>
  onAuthStateChange?: (
    cb: (event: string, session: unknown) => void
  ) => { data: { subscription: { unsubscribe: () => void } } }
  signInWithPassword?: (creds: { email: string; password: string }) => Promise<{ error: { message: string } | null }>
  signUp?: (creds: { email: string; password: string }) => Promise<{ error: { message: string } | null }>
  signOut?: () => Promise<{ error: null }>
}

export function createSupabaseMock(
  handlers: SupabaseHandlers,
  authOverrides: SupabaseAuthOverrides = {},
  rpcHandler?: RpcHandler
) {
  const from = vi.fn((table: string) => createQueryBuilder(handlers, table))

  const auth = {
    getSession: vi.fn(async () => ({ data: { session: null } })),
    onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })),
    signInWithPassword: vi.fn(async () => ({ error: null })),
    signUp: vi.fn(async () => ({ error: null })),
    signOut: vi.fn(async () => ({ error: null })),
    ...authOverrides,
  }

  const rpc = vi.fn((fnName: string, args: unknown) => {
    if (!rpcHandler) {
      return Promise.resolve({
        data: null,
        error: new Error(`[supabaseMock] no rpc handler configured (called "${fnName}")`),
      })
    }
    return Promise.resolve(rpcHandler(fnName, args))
  })

  return { from, auth, rpc }
}
