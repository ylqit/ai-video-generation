import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { parse, compileScript, compileTemplate } from '@vue/compiler-sfc';
import ts from 'typescript';
import * as Vue from 'vue';

// Mount the real SFC and template; only browser selection/capture APIs are simulated.
async function fixture(t: any) {
  const source = await fs.readFile('src/web/ResourceCanvas.vue', 'utf8');
  const { descriptor } = parse(source);
  const script = compileScript(descriptor, { id: 'canvas-test' });
  const template = compileTemplate({
    id: 'canvas-test',
    filename: 'ResourceCanvas.vue',
    source: descriptor.template!.content,
    compilerOptions: { bindingMetadata: script.bindings },
  });
  const exports: any = {};
  for (const code of [script.content, template.code]) {
    const compiled = ts.transpileModule(code, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    new Function('require', 'exports', compiled)((name: string) => {
      if (name === 'vue') return Vue;
      if (name === './api') return { assetUrl: () => '/fixture.png' };
      throw new Error(`Unexpected import: ${name}`);
    }, exports);
  }
  const nodes: any[] = [],
    captures = new Set<number>(),
    listeners = new Set<string>();
  let cleared = 0,
    intersects = true,
    state: any;
  const selection = {
    rangeCount: 1,
    getRangeAt: () => ({ intersectsNode: () => intersects }),
    removeAllRanges: () => {
      cleared++;
    },
  };
  const view = new EventTarget();
  const nativeAdd = view.addEventListener.bind(view),
    nativeRemove = view.removeEventListener.bind(view);
  view.addEventListener = (type, listener, options) => {
    listeners.add(type);
    nativeAdd(type, listener, options);
  };
  view.removeEventListener = (type, listener, options) => {
    listeners.delete(type);
    nativeRemove(type, listener, options);
  };
  Object.assign(view, { getSelection: () => selection });
  const document = { defaultView: view, getSelection: () => selection, activeElement: null as any };
  const create = (tag: string) => {
    const node: any = {
      tag,
      props: {},
      children: [],
      parent: null,
      ownerDocument: document,
      closest(selector: string): any {
        const matches = selector.split(',').some((part) => {
          part = part.trim();
          if (part.startsWith('.'))
            return String(this.props.class || '')
              .split(' ')
              .includes(part.slice(1));
          if (part.startsWith('[contenteditable'))
            return (
              this.props.contenteditable !== undefined && this.props.contenteditable !== 'false'
            );
          return part === this.tag;
        });
        return matches ? this : this.parent?.closest(selector) || null;
      },
      focus() {
        document.activeElement = this;
      },
      setPointerCapture(id: number) {
        captures.add(id);
      },
      hasPointerCapture(id: number) {
        return captures.has(id);
      },
      releasePointerCapture(id: number) {
        captures.delete(id);
        const canvas = nodes.find((n) => n.props.class === 'resource-canvas');
        canvas?.props.onLostpointercapture?.({ type: 'lostpointercapture', pointerId: id });
      },
    };
    nodes.push(node);
    return node;
  };
  const renderer = Vue.createRenderer<any, any>({
    patchProp(node, key, _previous, value) {
      node.props[key] = value;
    },
    insert(node, parent) {
      node.parent = parent;
      parent.children.push(node);
    },
    remove() {},
    createElement: create,
    createText: () => create('#text'),
    createComment: () => create('#comment'),
    setText() {},
    setElementText(node, text) {
      node.text = text;
    },
    parentNode: (node) => node.parent,
    nextSibling: () => null,
  });
  const component = exports.default,
    setup = component.setup;
  component.setup = (props: any, context: any) => {
    state = setup(props, context);
    return state;
  };
  component.render = exports.render;
  const emitted: any[] = [],
    opened: any[] = [];
  const app = renderer.createApp(component, {
    snapshot: {
      cards: [
        {
          id: 'card',
          type: 'asset',
          title: 'Card',
          group: 'story/direction',
          asset: { id: 'image', revision: 1 },
        },
      ],
      results: {},
      assets: [{ id: 'image', revision: 1, data: { mediaType: 'image' } }],
      edges: [],
    },
    positions: { unrelated: { x: 9, y: 8 } },
    onLayout: (positions: any) => emitted.push(JSON.parse(JSON.stringify(positions))),
    onOpen: (card: any) => opened.push(card.id),
  });
  app.mount(create('host'));
  t.after(() => {
    if (app._instance) app.unmount();
  });
  const canvas = nodes.find((n) => n.props.class === 'resource-canvas'),
    card = nodes.find((n) => n.tag === 'article');
  const event = (changes: any = {}) => ({
    type: 'pointerdown',
    isPrimary: true,
    pointerType: 'mouse',
    pointerId: 1,
    button: 0,
    buttons: 1,
    clientX: 100,
    clientY: 100,
    target: canvas,
    currentTarget: canvas,
    defaultPrevented: false,
    stopped: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
    stopPropagation() {
      this.stopped = true;
    },
    ...changes,
  });
  return {
    state,
    nodes,
    canvas,
    card,
    view,
    document,
    event,
    captures,
    listeners,
    emitted,
    opened,
    app,
    create,
    get cleared() {
      return cleared;
    },
    outsideSelection() {
      intersects = false;
    },
  };
}

test('canvas drag prevents browser selection and clears only intersecting selections', async (t) => {
  const f = await fixture(t),
    down = f.event();
  f.canvas.props.onPointerdown(down);
  assert.equal(down.defaultPrevented, true);
  assert.equal(f.cleared, 1);
  f.canvas.props.onPointermove(f.event({ type: 'pointermove', clientX: 130, clientY: 140 }));
  assert.deepEqual(f.state.pan.value, { x: 58, y: 68 });
  f.canvas.props.onPointerup(f.event({ type: 'pointerup', buttons: 0 }));
  assert.equal(f.emitted.length, 0);
  f.outsideSelection();
  f.canvas.props.onPointerdown(f.event());
  assert.equal(f.cleared, 1);
});

test('click jitter never moves or saves a card, while scaled dragging saves once and keeps focus', async (t) => {
  const f = await fixture(t),
    down = () => f.event({ target: f.card, currentTarget: f.card });
  f.card.props.onPointerdown(down());
  assert.ok(f.document.activeElement === f.card, 'dragged card keeps keyboard focus');
  f.canvas.props.onPointermove(f.event({ type: 'pointermove', clientX: 103, clientY: 102 }));
  assert.deepEqual(f.state.temporary.value, {});
  f.canvas.props.onPointerup(f.event({ type: 'pointerup', buttons: 0 }));
  assert.equal(f.emitted.length, 0);
  f.state.scale.value = 0.5;
  f.card.props.onPointerdown(down());
  f.canvas.props.onPointermove(f.event({ type: 'pointermove', clientX: 120, clientY: 110 }));
  f.canvas.props.onPointerup(f.event({ type: 'pointerup', buttons: 0 }));
  f.canvas.props.onPointerup(f.event({ type: 'pointerup', buttons: 0 }));
  assert.deepEqual(f.emitted, [{ unrelated: { x: 9, y: 8 }, card: { x: 40, y: 66 } }]);
  assert.equal(f.captures.size, 0);
  assert.equal(f.listeners.size, 0);
});

test('only the primary left pointer owns movement and release', async (t) => {
  const f = await fixture(t);
  for (const changes of [{ button: 2 }, { isPrimary: false }]) {
    const down = f.event(changes);
    f.canvas.props.onPointerdown(down);
    assert.equal(down.defaultPrevented, false);
    assert.equal(f.captures.size, 0);
  }
  f.canvas.props.onPointerdown(f.event());
  f.canvas.props.onPointerdown(f.event({ pointerId: 2 }));
  f.canvas.props.onPointermove(f.event({ type: 'pointermove', pointerId: 2, clientX: 200 }));
  f.canvas.props.onPointerup(f.event({ type: 'pointerup', pointerId: 2, buttons: 0 }));
  assert.deepEqual(f.state.pan.value, { x: 28, y: 28 });
  assert.deepEqual([...f.captures], [1]);
  f.canvas.props.onPointermove(f.event({ type: 'pointermove', clientX: 120 }));
  assert.deepEqual(f.state.pan.value, { x: 48, y: 28 });
});

test('pointer cancel, lost capture, blur, button loss and unmount roll back without saving', async (t) => {
  for (const ending of ['cancel', 'capture', 'blur', 'buttons', 'unmount']) {
    const f = await fixture(t);
    f.state.temporary.value.card = { x: 7, y: 12 };
    f.card.props.onPointerdown(f.event({ target: f.card, currentTarget: f.card }));
    f.canvas.props.onPointermove(f.event({ type: 'pointermove', clientX: 140 }));
    if (ending === 'cancel') f.canvas.props.onPointercancel(f.event({ type: 'pointercancel' }));
    if (ending === 'capture') f.card.releasePointerCapture(1);
    if (ending === 'blur') f.view.dispatchEvent(new Event('blur'));
    if (ending === 'buttons')
      f.canvas.props.onPointermove(f.event({ type: 'pointermove', buttons: 0 }));
    if (ending === 'unmount') f.app.unmount();
    assert.deepEqual(f.state.temporary.value.card, { x: 7, y: 12 }, ending);
    assert.equal(f.emitted.length, 0, ending);
    assert.equal(f.captures.size, 0, ending);
    assert.equal(f.listeners.size, 0, ending);
  }
});

test('auto layout cancels active movement and ignores late events', async (t) => {
  const f = await fixture(t);
  f.card.props.onPointerdown(f.event({ target: f.card, currentTarget: f.card }));
  f.canvas.props.onPointermove(f.event({ type: 'pointermove', clientX: 140 }));
  f.state.autoLayout();
  f.canvas.props.onPointermove(f.event({ type: 'pointermove', clientX: 200 }));
  f.canvas.props.onPointerup(f.event({ type: 'pointerup', buttons: 0 }));
  assert.deepEqual(f.state.temporary.value, {});
  assert.deepEqual(f.state.pan.value, { x: 28, y: 28 });
  assert.equal(f.state.scale.value, 1);
  assert.deepEqual(f.emitted, [{}]);
});

test('keyboard focus reveals an offscreen card through pan without saving a layout', async (t) => {
  const f = await fixture(t);
  f.canvas.getBoundingClientRect = () => ({ left: 0, top: 200, right: 1280, bottom: 700 });
  f.card.getBoundingClientRect = () => ({ left: -100, top: 600, right: 160, bottom: 818 });
  f.canvas.props.onFocusin({ target: f.card, currentTarget: f.canvas });
  assert.deepEqual(f.state.pan.value, { x: 144, y: -166 });
  assert.equal(f.emitted.length, 0);
  f.card.getBoundingClientRect = () => ({ left: 16, top: 406, right: 276, bottom: 624 });
  f.canvas.props.onFocusin({ target: f.card, currentTarget: f.canvas });
  assert.deepEqual(f.state.pan.value, { x: 144, y: -166 });
});

test('controls remain clickable, editable fields stay independent and thumbnails do not drag natively', async (t) => {
  const f = await fixture(t);
  const thumbnail = f.nodes.find((n) => n.props.class === 'resource-thumbnail');
  const controls = f.nodes.find((n) => n.props.class === 'canvas-controls');
  const output = f.nodes.find((n) => n.tag === 'output');
  for (const target of [
    thumbnail,
    controls,
    output,
    ...['a', 'input', 'textarea', 'select', 'video', 'audio'].map(f.create),
  ]) {
    target.parent ||= f.canvas;
    const event = f.event({ target });
    f.canvas.props.onPointerdown(event);
    assert.equal(event.defaultPrevented, false, target.tag);
    assert.equal(f.captures.size, 0, target.tag);
  }
  const editable = f.create('div');
  editable.props.contenteditable = '';
  editable.parent = f.canvas;
  f.canvas.props.onPointerdown(f.event({ target: editable }));
  assert.equal(f.captures.size, 0);
  thumbnail.props.onClick(f.event());
  assert.deepEqual(f.opened, ['card']);
  assert.equal(f.nodes.find((n) => n.tag === 'img').props.draggable, false);
  const nativeDrag = f.event({ type: 'dragstart', target: thumbnail });
  thumbnail.props.onDragstart(nativeDrag);
  assert.equal(nativeDrag.defaultPrevented, true);
});

test('canvas keyboard selection is focus scoped and editable text keeps native select all', async (t) => {
  const f = await fixture(t);
  const key = (target: any) => f.event({ type: 'keydown', key: 'a', ctrlKey: true, target });
  let e = key(f.canvas);
  f.canvas.props.onKeydown(e);
  assert.equal(e.defaultPrevented, false);
  f.canvas.focus();
  e = key(f.canvas);
  f.canvas.props.onKeydown(e);
  assert.equal(e.defaultPrevented, true);
  assert.deepEqual([...f.state.multiSelected.value], ['card']);
  const input = f.create('textarea');
  input.parent = f.canvas;
  input.focus();
  e = key(input);
  f.canvas.props.onKeydown(e);
  assert.equal(e.defaultPrevented, false);
  f.card.props.onPointerdown(f.event({ target: f.card, currentTarget: f.card }));
  assert.equal(f.state.dragging.value, true);
  f.view.dispatchEvent(new Event('blur'));
  assert.equal(f.state.dragging.value, false);
});

test('mouse wheel, horizontal touchpad and ctrl wheel operate canvas without saving production data', async (t) => {
  const f = await fixture(t);
  const wheel = f.event({ type: 'wheel', deltaX: 20, deltaY: 40, deltaMode: 0 });
  f.canvas.props.onWheel(wheel);
  assert.deepEqual(f.state.pan.value, { x: 8, y: -12 });
  assert.equal(wheel.defaultPrevented, true);
  f.canvas.props.onWheel(f.event({ type: 'wheel', deltaY: 100, deltaMode: 0, ctrlKey: true }));
  assert.equal(f.state.scale.value, 0.9);
  assert.equal(f.emitted.length, 0);
});
