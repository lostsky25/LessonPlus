import { type ServiceName, type SystemStatus } from '@lessonplus/contracts';
import { useCallback, useEffect, useState } from 'react';
import { sectionTitle } from './sections.js';

type LoadState = { kind: 'loading' } | { kind: 'ready'; status: SystemStatus } | { kind: 'error' };

export function StatusPage() {
  const [state, setState] = useState<LoadState>({ kind: 'loading' });

  const load = useCallback(async () => {
    setState({ kind: 'loading' });
    try {
      const response = await fetch('/api/system/status', { cache: 'no-store' });
      if (!response.ok) {
        setState({ kind: 'error' });
        return;
      }
      const status = (await response.json()) as SystemStatus;
      setState({ kind: 'ready', status });
    } catch {
      setState({ kind: 'error' });
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void load();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  return (
    <section>
      <div className="toolbar">
        <h2>Состояние сервисов</h2>
        <button type="button" onClick={() => void load()} disabled={state.kind === 'loading'}>
          Обновить
        </button>
      </div>
      {state.kind === 'loading' ? <p>Проверяем состояние сервисов…</p> : null}
      {state.kind === 'error' ? (
        <p className="error" role="alert">
          Не удалось получить статусы. Проверьте, что API gateway запущен.
        </p>
      ) : null}
      {state.kind === 'ready' ? (
        <div className="grid">
          {state.status.services.map((service) => (
            <article className="panel" key={service.name}>
              <h3>{sectionTitle(service.name as ServiceName)}</h3>
              <p>
                Процесс: <StatusValue value={service.live} />
              </p>
              <p>
                Готовность: <StatusValue value={service.ready} />
              </p>
            </article>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function StatusValue({ value }: { value: 'up' | 'down' }) {
  return (
    <strong className={value === 'up' ? 'up' : 'down'}>
      {value === 'up' ? 'доступен' : 'недоступен'}
    </strong>
  );
}
