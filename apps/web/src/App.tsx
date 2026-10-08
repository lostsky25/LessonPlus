import { BrowserRouter, NavLink, Route, Routes } from 'react-router-dom';
import { PlaceholderPage } from './PlaceholderPage.js';
import { StatusPage } from './StatusPage.js';
import { sections } from './sections.js';

export function App() {
  return (
    <BrowserRouter>
      <div className="shell">
        <header>
          <p className="eyebrow">Учебный центр</p>
          <h1>Система учёта абонементов и переносов занятий</h1>
          <p className="lead">
            Каркас сервисов: статусы подключений уже живые, бизнес-разделы появятся на следующем
            этапе.
          </p>
        </header>
        <nav aria-label="Разделы">
          <NavLink to="/" end>
            Состояние
          </NavLink>
          {sections.map((section) => (
            <NavLink key={section.path} to={section.path}>
              {section.title}
            </NavLink>
          ))}
        </nav>
        <main>
          <Routes>
            <Route path="/" element={<StatusPage />} />
            {sections.map((section) => (
              <Route
                key={section.path}
                path={section.path}
                element={<PlaceholderPage title={section.title} />}
              />
            ))}
          </Routes>
        </main>
      </div>
    </BrowserRouter>
  );
}
