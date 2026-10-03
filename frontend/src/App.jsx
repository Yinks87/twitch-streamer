import { BrowserRouter, Routes, Route } from 'react-router-dom';
import Login from './pages/Login';
import Home from './pages/Home';
import Settings from './pages/Settings';
import AlertComponent from './components/AlertComponent';
import { useAlert } from './context/AlertContext';

// ── App-level router ─────────────────────────────────────────────────────────
export default function App() {
  const { alerts } = useAlert();
  return (
    <BrowserRouter
      future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
    >
      <Routes>
        <Route path="/" element={<Login />} />
        <Route path="/app" element={<Home />} />
        <Route path="/settings" element={<Settings />} />
      </Routes>
      <AlertComponent alerts={alerts} />
    </BrowserRouter>
  );
}
