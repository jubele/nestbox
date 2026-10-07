import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { LogLine } from '@shared/processes';
import { installMockBridge } from '@/test/mock-bridge';
import { renderWithProviders } from '@/test/render';
import { LogPane } from './LogPane';

let seq = 0;
const line = (text: string, stream: LogLine['stream'] = 'stdout'): LogLine => ({ seq: ++seq, ts: Date.UTC(2026, 9, 1), stream, text });
const pino = (level: number, msg: string, extra: Record<string, unknown> = {}) => line(JSON.stringify({ level, msg, ...extra }));

const ref = (script: string) => ({ projectId: 'p1', script });

function setup(lines: LogLine[], over: Record<string, (input: never) => unknown> = {}) {
  const calls: { method: string; input: unknown }[] = [];
  const bridge = installMockBridge({
    'tools:invoke': (({ method, input }: { method: string; input: unknown }) => {
      calls.push({ method, input });
      const handler = over[method];
      if (handler) return handler(input as never);
      if (method === 'getLogs') return { lines, firstSeq: lines[0]?.seq ?? 1, lastSeq: lines.at(-1)?.seq ?? 0 };
      if (method === 'clearLogs' || method === 'openFileAt') return undefined;
      if (method === 'exportLogs') return { saved: true };
      throw new Error(`unexpected ${method}`);
    }) as never,
  });
  const onScriptChange = vi.fn();
  renderWithProviders(
    <LogPane
      target={ref('dev')}
      options={[
        { ref: ref('dev'), label: 'dev' },
        { ref: ref('build'), label: 'build' },
      ]}
      onTargetChange={onScriptChange}
      active
      onActivate={() => {}}
    />,
  );
  return { bridge, calls, onScriptChange };
}

// react-virtual sizes the viewport from offsetWidth/offsetHeight, which jsdom always reports as 0.
const layout = { offsetHeight: 600, offsetWidth: 800 };
const originals = Object.fromEntries(
  Object.keys(layout).map((key) => [key, Object.getOwnPropertyDescriptor(HTMLElement.prototype, key)]),
);
beforeAll(() => {
  for (const [key, value] of Object.entries(layout)) {
    Object.defineProperty(HTMLElement.prototype, key, { configurable: true, get: () => value });
  }
});
afterAll(() => {
  for (const [key, descriptor] of Object.entries(originals)) {
    if (descriptor) Object.defineProperty(HTMLElement.prototype, key, descriptor);
  }
});

describe('LogPane', () => {
  it('asks for a script when none is picked', () => {
    installMockBridge({});
    renderWithProviders(<LogPane target={null} options={[{ ref: ref('dev'), label: 'dev' }]} onTargetChange={() => {}} active onActivate={() => {}} />);
    expect(screen.getByText('Pick a script to see its output.')).toBeInTheDocument();
  });

  it('renders ANSI colours as token classes without raw escapes', async () => {
    setup([line('\u001b[31mred alert\u001b[0m done')]);
    const red = await screen.findByText('red alert');
    expect(red).toHaveClass('ansi-fg-1');
    expect(screen.getByRole('log').innerHTML).not.toContain('\u001b');
  });

  it('offers to free the port when the script failed with EADDRINUSE', async () => {
    setup([line('▸ pnpm run dev', 'system'), line('Error: listen EADDRINUSE: address already in use :::3000', 'stderr')]);
    expect(await screen.findByRole('alert')).toHaveTextContent('Port 3000 is in use');
  });

  it('shows no port banner for an address-in-use error before the last start', async () => {
    setup([line('EADDRINUSE :::3000', 'stderr'), line('▸ pnpm run dev', 'system'), line('ready', 'stdout')]);
    expect(await screen.findByText('ready')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('marks stderr and system lines', async () => {
    setup([line('▸ pnpm run dev', 'system'), line('oops', 'stderr')]);
    const oops = await screen.findByText('oops');
    expect(oops.closest('[data-stream]')).toHaveAttribute('data-stream', 'stderr');
    expect(screen.getByText('▸ pnpm run dev').closest('[data-stream]')).toHaveAttribute('data-stream', 'system');
  });

  it('renders structured rows and expands them', async () => {
    setup([pino(30, 'GET /', { context: 'Http', reqId: 'req-1' })]);
    expect(await screen.findByText('GET /')).toBeInTheDocument();
    expect(within(screen.getByRole('log')).getByText('info')).toBeInTheDocument();
    expect(screen.getByText('[Http]')).toBeInTheDocument();
    expect(screen.getByText('req-1')).toBeInTheDocument();
    const toggle = screen.getByRole('button', { name: 'Expand entry' });
    await userEvent.click(toggle);
    expect(screen.getByRole('button', { name: 'Collapse entry' })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText(/"reqId": "req-1"/)).toBeInTheDocument();
  });

  it('hides plain lines while a level filter is set', async () => {
    setup([line('plain text'), pino(30, 'info line'), pino(50, 'error line')]);
    await screen.findByText('plain text');
    await userEvent.click(screen.getByRole('button', { name: 'error' }));
    expect(screen.queryByText('plain text')).toBeNull();
    expect(screen.queryByText('info line')).toBeNull();
    expect(screen.getByText('error line')).toBeInTheDocument();
    expect(screen.getByText('Showing matching entries and the lines under them')).toBeInTheDocument();
  });

  it('filters by context', async () => {
    setup([pino(30, 'a', { context: 'Http' }), pino(30, 'b', { context: 'Db' })]);
    await screen.findByText('a');
    await userEvent.click(screen.getByRole('combobox', { name: 'Context' }));
    await userEvent.click(await screen.findByRole('option', { name: 'Db' }));
    expect(screen.queryByText('a')).toBeNull();
    expect(screen.getByText('b')).toBeInTheDocument();
  });

  it('highlights search hits and steps through them', async () => {
    setup([line('boom one'), line('fine'), line('boom two')]);
    await screen.findByText('fine');
    await userEvent.type(screen.getByRole('textbox', { name: 'Search output' }), 'boom');
    expect(screen.getAllByText('boom', { selector: 'mark span' })).toHaveLength(2);
    expect(screen.getByText('1 / 2')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Next match' }));
    expect(screen.getByText('2 / 2')).toBeInTheDocument();
    await userEvent.type(screen.getByRole('textbox', { name: 'Search output' }), '{Enter}');
    expect(screen.getByText('1 / 2')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Follow' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('opens file links', async () => {
    const { calls } = setup([line('at src/a.ts:12 failed')]);
    await userEvent.click(await screen.findByRole('button', { name: 'src/a.ts:12' }));
    await waitFor(() =>
      expect(calls).toContainEqual({ method: 'openFileAt', input: { path: 'src/a.ts', line: 12 } }),
    );
  });

  it('exports everything without a filter and the visible seqs with one', async () => {
    const lines = [line('plain'), pino(50, 'bad')];
    const { calls } = setup(lines);
    await screen.findByText('plain');
    await userEvent.click(screen.getByRole('button', { name: 'Export' }));
    await waitFor(() => expect(calls).toContainEqual({ method: 'exportLogs', input: { script: 'dev', seqs: 'all' } }));
    await userEvent.click(screen.getByRole('button', { name: 'error' }));
    await userEvent.click(screen.getByRole('button', { name: 'Export' }));
    await waitFor(() =>
      expect(calls).toContainEqual({ method: 'exportLogs', input: { script: 'dev', seqs: [lines[1]?.seq] } }),
    );
    expect((await screen.findAllByText('Log exported')).length).toBeGreaterThan(0);
  });

  it('clears', async () => {
    const { calls } = setup([line('old')]);
    await screen.findByText('old');
    await userEvent.click(screen.getByRole('button', { name: 'Clear' }));
    await waitFor(() => expect(screen.queryByText('old')).toBeNull());
    expect(calls).toContainEqual({ method: 'clearLogs', input: { script: 'dev' } });
  });

  it('appends streamed lines', async () => {
    const { bridge } = setup([line('first')]);
    await screen.findByText('first');
    const next = { ...line('second') };
    act(() =>
      bridge.emit('tools:event', { toolId: 'scripts', projectId: 'p1', event: 'logs', payload: { script: 'dev', lines: [next] } }),
    );
    expect(await screen.findByText('second')).toBeInTheDocument();
  });

  it('pauses follow when scrolled up and resumes on click', async () => {
    setup([line('a'), line('b')]);
    await screen.findByText('a');
    const log = screen.getByRole('log');
    const follow = screen.getByRole('button', { name: 'Follow' });
    expect(follow).toHaveAttribute('aria-pressed', 'true');
    Object.defineProperty(log, 'scrollHeight', { configurable: true, value: 1000 });
    Object.defineProperty(log, 'clientHeight', { configurable: true, value: 200 });
    log.scrollTop = 100;
    fireEvent.scroll(log);
    expect(follow).toHaveAttribute('aria-pressed', 'false');
    await userEvent.click(follow);
    expect(follow).toHaveAttribute('aria-pressed', 'true');
  });

  it('switches scripts from the picker', async () => {
    const { onScriptChange } = setup([line('a')]);
    await screen.findByText('a');
    await userEvent.click(screen.getByRole('combobox', { name: 'Script' }));
    await userEvent.click(await screen.findByRole('option', { name: 'build' }));
    expect(onScriptChange).toHaveBeenCalledWith(ref('build'));
  });

  it('labels the region by script', async () => {
    setup([line('a')]);
    const region = await screen.findByRole('region', { name: 'dev log' });
    expect(within(region).getByRole('log', { name: 'dev output' })).toBeInTheDocument();
  });
});
