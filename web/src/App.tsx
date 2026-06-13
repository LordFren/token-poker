import { useApp } from "./store";
import { Landing } from "./screens/Landing";
import { Room } from "./screens/Room";
import { Expired } from "./screens/Expired";

export function App() {
  const { state } = useApp();
  const { route, toast } = state;

  return (
    <div className="app">
      {route.name === "landing" && <Landing />}
      {route.name === "join" && <Landing prefillCode={route.code} />}
      {route.name === "room" && <Room />}
      {route.name === "expired" && <Expired />}
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
