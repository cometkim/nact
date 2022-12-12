import { ActorSystemRef, localActorRef, LocalActorRef, LocalActorSystemRef, localTemporaryRef } from "./references";
import { Deferral } from './deferral';
import { applyOrThrowIfStopped, find } from './system-map';
import Queue from './vendored/denque';
import assert from './assert';
import { defaultSupervisionPolicy, SupervisionActions } from './supervision';
import { ActorPath } from "./paths";
import { Milliseconds } from ".";
import { addMacrotask, clearMacrotask } from './macrotask'
import { ICanAssertNotStopped, ICanDispatch, ICanHandleFault, ICanManageTempReferences, ICanQuery, ICanReset, ICanStop, IHaveChildren, IHaveName, InferResponseFromMsgFactory, QueryMsgFactory } from "./interfaces";

function unit(): void { };

export type ActorName = string;

// type InferMsgFromRef<R extends Ref<any>> = R extends Ref<infer Msg> ? Msg : never;
export type ParentTypeFromRefType<P extends LocalActorSystemRef | LocalActorRef<any>> =
  P extends ActorSystemRef
  ? RequiredActorSystemCapabilities
  : (P extends LocalActorRef<infer Msg>
    ? (RequiredChildCapabilities & ICanDispatch<Msg> & ICanHandleFault<RequiredChildCapabilities> & IHaveChildren<RequiredChildCapabilities, RequiredActorSystemCapabilities>)
    : never);

export type RequiredChildCapabilities =
  ICanReset
  & ICanStop
  & IHaveChildren<RequiredChildCapabilities, RequiredActorSystemCapabilities>
  & IHaveName
  & ICanAssertNotStopped;

export type RequiredActorSystemCapabilities =
  ICanReset
  & ICanStop
  & IHaveChildren<RequiredChildCapabilities, RequiredActorSystemCapabilities>
  & IHaveName
  & ICanHandleFault<RequiredChildCapabilities>
  & ICanAssertNotStopped
  & ICanManageTempReferences;

export class Actor<State, Msg, ParentRef extends LocalActorSystemRef | LocalActorRef<any>, Child extends RequiredChildCapabilities = RequiredChildCapabilities> implements ICanDispatch<Msg>, ICanStop, ICanQuery<Msg>, IHaveName, IHaveChildren<Child, RequiredActorSystemCapabilities>, ICanReset, ICanHandleFault<Child>, ICanAssertNotStopped {
  // TODO: Swap concreate parent class for interfaces
  parent: ParentTypeFromRefType<ParentRef>

  name: ActorName;
  path: ActorPath;
  system: RequiredActorSystemCapabilities;
  afterStop: (state: State, ctx: ActorContext<Msg, ParentRef>) => void | Promise<void>;
  reference: LocalActorRef<Msg>;
  f: ActorFunc<State, Msg, ParentRef>;
  stopped: boolean;

  children: Map<string, Child>;
  childReferences: Map<string, LocalActorRef<unknown>>;
  busy: boolean;
  mailbox: Queue<{ message: Msg }>;
  immediate: number | undefined;
  onCrash: SupervisionActorFunc<Msg, ParentRef> | ((msg: any, err: any, ctx: any, child?: undefined | LocalActorRef<unknown>) => any);
  initialState: State | undefined;
  initialStateFunc: ((ctx: ActorContext<Msg, ParentRef>) => State | Promise<State>) | undefined;
  initializeStatePromise: Promise<void>
  shutdownPeriod?: Milliseconds;
  state: any;
  timeout?: Milliseconds;
  setTimeout: () => void;

  constructor(
    parent: ParentTypeFromRefType<ParentRef>,
    system: RequiredActorSystemCapabilities,
    f: ActorFunc<State, Msg, ParentRef>,
    { name, shutdownAfter, onCrash, initialState, initialStateFunc, afterStop }: ActorProps<State, Msg, ParentRef> = {}) {
    this.parent = parent;
    if (!name) {
      name = `anonymous-${Math.abs(Math.random() * Number.MAX_SAFE_INTEGER) | 0}`;
    }
    if (parent.children.has(name)) {
      throw new Error(`child actor of name ${name} already exists`);
    }
    this.name = name;
    this.path = ActorPath.createChildPath(parent.reference.path, this.name);
    this.system = system;
    this.afterStop = afterStop || (() => { });
    this.reference = localActorRef(this.path);
    this.f = f;
    this.stopped = false;
    this.children = new Map();
    this.childReferences = new Map();
    this.busy = false;
    this.mailbox = new Queue();
    this.immediate = undefined;
    this.parent.childSpawned(this);
    this.onCrash = onCrash ?? defaultSupervisionPolicy;
    this.initialState = initialState;
    this.initialStateFunc = initialStateFunc;
    if (shutdownAfter) {
      if (typeof (shutdownAfter) !== 'number') {
        throw new Error('Shutdown should be specified as a number in milliseconds');
      }
      this.shutdownPeriod = Actor.getSafeTimeout(shutdownAfter);
      this.setTimeout = () => {
        this.timeout = globalThis.setTimeout(() => this.stop(), this.shutdownPeriod) as unknown as number;
      };
    } else {
      this.setTimeout = unit;
    }
    this.initializeStatePromise = this.initializeState();
    this.setTimeout();
  }

  async waitUntilInitialized() {
    await this.initializeStatePromise;
  }

  async initializeState() {
    if (this.initialStateFunc) {
      try {
        this.state = await Promise.resolve(this.initialStateFunc(this.createContext()));
      } catch (e) {
        await this.handleFault(undefined, e as Error | undefined);
      }
    } else {
      this.state = this.initialState;
    }
  }


  reset() {
    [...this.children.values()].forEach(x => x.stop());
    this.initializeStatePromise = this.initializeState();
    this.resume();
  }

  clearTimeout() {
    globalThis.clearTimeout(this.timeout);
  }

  clearImmediate() {
    clearMacrotask(this.immediate);
  }

  static getSafeTimeout(timeoutDuration: any) {
    timeoutDuration = timeoutDuration | 0;
    const MAX_TIMEOUT = 2147483647;
    return Math.min(MAX_TIMEOUT, timeoutDuration);
  }

  assertNotStopped() { assert(!this.stopped); return true; }
  afterMessage() { }

  dispatch(message: Msg) {
    this.assertNotStopped();
    this.clearTimeout();
    if (!this.busy) {
      this.handleMessage(message);
    } else {
      this.mailbox.push({ message });
    }

    return Promise.resolve();
  }

  query<MsgCreator extends QueryMsgFactory<Msg, any>>(queryFactory: MsgCreator, timeout: Milliseconds): Promise<InferResponseFromMsgFactory<MsgCreator>> {
    this.assertNotStopped();
    assert(timeout !== undefined && timeout !== null);
    const deferred = new Deferral<InferResponseFromMsgFactory<MsgCreator>>();

    timeout = Actor.getSafeTimeout(timeout);
    const timeoutHandle = globalThis.setTimeout(() => { deferred.reject(new Error('Query Timeout ' + timeout)); }, timeout);
    const tempReference = localTemporaryRef(this.system.name);
    this.system.addTempReference(tempReference, deferred);
    deferred.promise.then(() => {
      globalThis.clearTimeout(timeoutHandle);
      this.system.removeTempReference(tempReference);
    }).catch(() => {
      this.system.removeTempReference(tempReference);
    });

    const message = queryFactory(tempReference);
    this.dispatch(message);
    return deferred.promise;
  }

  childStopped(child: Child) {
    this.children.delete(child.name);
    this.childReferences.delete(child.name);
  }

  childSpawned(child: Child) {
    this.children.set(child.name, child);
    this.childReferences.set(child.name, child.reference as LocalActorRef<unknown>);
  }

  stop() {
    const context = this.createContext();

    this.clearImmediate();
    this.clearTimeout();
    this.parent.childStopped(this);
    delete (this as any).parent;
    [...this.children.values()].forEach(x => x.stop());
    this.stopped = true;

    addMacrotask(() => this.afterStop(this.state, context));
  }

  processNext() {
    if (!this.stopped) {
      const nextMsg = this.mailbox.shift();
      if (nextMsg) {
        this.handleMessage(nextMsg.message);
      } else {
        this.busy = false;
        // Counter is now ticking until actor is killed
        this.setTimeout();
      }
    }
  }

  async handleFault(msg: unknown, error: Error | undefined, child: undefined | Child = undefined) {
    const ctx = this.createSupervisionContext();
    const decision = await Promise.resolve(this.onCrash(msg, error, ctx, child?.reference as LocalActorRef<unknown>));
    switch (decision) {
      // Stop Self
      case SupervisionActions.stop:
        this.stop();
        break;
      // Stop Self and Peers
      case SupervisionActions.stopAll:
        [...this.parent.children.values()].forEach(x => x.stop());
        break;
      // Stop Child
      case SupervisionActions.stopChild:
        assert(child, 'Expected child');
        this.children.get(child.name)?.stop();
        break;
      // Stop All Children
      case SupervisionActions.stopAllChildren:
        [...this.children.values()].forEach(x => x.stop());
        break;
      // Resume
      case SupervisionActions.resume:
        this.resume();
        break;
      // Reset Self
      case SupervisionActions.reset:
        this.reset();
        break;
      // Reset Self and Peers
      case SupervisionActions.resetAll:

        this.parent.children.forEach(x => x.reset());
        break;
      // Reset Child
      case SupervisionActions.resetChild:
        assert(child, 'Expected child');
        this.children.get(child.name)?.reset();
        break;
      // Reset all Children
      case SupervisionActions.resetAllChildren:
        [...this.children.values()].forEach(x => x.reset());
        break;
      // Escalate to Parent
      case SupervisionActions.escalate:
      default:
        this.parent.handleFault(msg, error, this);
        break;
    }
  }

  resume() {
    this.processNext();
  }

  createSupervisionContext() {
    const ctx = this.createContext();
    return { ...ctx, ...SupervisionActions };
  }



  createContext(): ActorContext<Msg, ParentRef> {
    return {
      mailbox: this.mailbox,
      parent: this.parent.reference as ParentRef,
      path: this.path,
      self: this.reference,
      name: this.name,
      children: new Map(this.childReferences),
    };
  }

  handleMessage(message: Msg) {
    this.busy = true;
    this.immediate = addMacrotask(async () => {
      try {
        await this.waitUntilInitialized();
        let ctx = this.createContext();
        let next = await Promise.resolve(this.f.call(ctx, this.state, message, ctx));
        this.state = next;
        this.afterMessage();
        this.processNext();
      } catch (e) {
        this.handleFault(message, e as Error | undefined);
      }
    });
  }
}


// Contexts
export type ActorContext<Msg, ParentRef extends LocalActorRef<any> | ActorSystemRef> = {
  parent: ParentRef,
  path: ActorPath,
  self: LocalActorRef<Msg>,
  name: ActorName,
  children: Map<ActorName, LocalActorRef<unknown>>,
  mailbox: Queue<{ message: Msg }>
};


export type Mailbox<Msg> = { message: Msg }[];

export type SupervisionContext<Msg, ParentRef extends ActorSystemRef | LocalActorRef<any>> = ActorContext<Msg, ParentRef> & {
  stop: Symbol,
  stopAll: Symbol,
  stopChild: Symbol,
  stopAllChildren: Symbol,
  escalate: Symbol,
  resume: Symbol,
  reset: Symbol,
  resetAll: Symbol,
  resetChild: Symbol,
  resetAllChildren: Symbol
};

// Functions
export type ActorFunc<State, Msg, ParentRef extends ActorSystemRef | LocalActorRef<any>> = (this: ActorContext<Msg, ParentRef>, state: State, msg: Msg, ctx: ActorContext<Msg, ParentRef>) =>
  State | Promise<State>;

export type StatelessActorFunc<Msg, ParentRef extends ActorSystemRef | LocalActorRef<any>> = (this: ActorContext<Msg, ParentRef>, msg: Msg, ctx: ActorContext<Msg, ParentRef>) => any;


export type SupervisionActorFunc<Msg, ParentRef extends ActorSystemRef | LocalActorRef<any>> = (msg: unknown, err: Error | undefined, ctx: SupervisionContext<Msg, ParentRef>, child: LocalActorRef<unknown>) => Symbol | Promise<Symbol>;

// Inference helpers
export type InferMsgFromFunc<T extends ActorFunc<any, any, any>> = T extends ActorFunc<any, infer Msg, any> ? Msg : never;
export type InferStateFromFunc<T extends ActorFunc<any, any, any>> = T extends ActorFunc<infer State, any, any> ? State : never;

export type InferMsgFromStatelessFunc<T extends StatelessActorFunc<any, any>> = T extends StatelessActorFunc<infer Msg, any> ? Msg : never;

// Props
export type NumberOfMessages = number;
export type Json = unknown;

export type ActorProps<State, Msg, ParentRef extends ActorSystemRef | LocalActorRef<any>> = {
  name?: string,
  shutdownAfter?: Milliseconds,
  onCrash?: SupervisionActorFunc<Msg, ParentRef>,
  initialState?: State,
  initialStateFunc?: (ctx: ActorContext<Msg, ParentRef>) => State | Promise<State>,
  afterStop?: (state: State, ctx: ActorContext<Msg, ParentRef>) => void | Promise<void>
};

export type StatelessActorProps<ParentRef extends ActorSystemRef | LocalActorRef<any>> = {
  name?: string,
  shutdownAfter?: Milliseconds,
  onCrash?: SupervisionActorFunc<InferMsgFromStatelessFunc<any>, ParentRef>,
};


export function spawn<ParentRef extends LocalActorSystemRef | LocalActorRef<any>, Func extends ActorFunc<any, any, ParentRef>>(
  parent: ParentRef,
  f: Func,
  properties?: ActorProps<InferStateFromFunc<Func>, InferMsgFromFunc<Func>, ParentRef> | StatelessActorProps<ParentRef>
): LocalActorRef<InferMsgFromFunc<Func>> {
  return applyOrThrowIfStopped(
    parent,
    (p: ParentTypeFromRefType<ParentRef>) =>
      p.assertNotStopped() &&
      new Actor(
        p,
        p.system,
        f,
        properties ?? {}
      )
  ).reference;
}

const statelessSupervisionPolicy = (_: unknown, __: unknown, ctx: SupervisionContext<any, any>) => ctx.resume;

export function spawnStateless<ParentRef extends LocalActorSystemRef | LocalActorRef<any>, Func extends StatelessActorFunc<any, ParentRef>>(
  parent: ParentRef,
  f: Func,
  propertiesOrName?: StatelessActorProps<ParentRef>
): LocalActorRef<InferMsgFromStatelessFunc<Func>> {
  return spawn(
    parent,
    (_state: undefined, msg: InferMsgFromStatelessFunc<Func>, ctx: ActorContext<InferMsgFromStatelessFunc<Func>, ParentRef>): undefined => {
      void executeStatelessActorFunc(f, msg, ctx);
      return undefined;
    },
    {
      onCrash: statelessSupervisionPolicy,
      ...propertiesOrName
    }
  );
}


async function executeStatelessActorFunc<ParentRef extends LocalActorSystemRef | LocalActorRef<any>,
  Func extends StatelessActorFunc<any, ParentRef>>(
  f: Func,
  msg: InferMsgFromStatelessFunc<Func>,
  ctx: ActorContext<any, ParentRef>
) {
  try {
    await f.call(ctx, msg, ctx);
  } catch (e: unknown) {
    if (e instanceof Error) {
      const actor = find<Actor<any, any, any>>(ctx.self);
      if (actor) {
        await actor.handleFault(msg, e);
      } else throw e;
    } else throw e;
  }
}
