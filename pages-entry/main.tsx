import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import Zhepage from "../app/page";
import "../app/globals.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Zhepage />
  </StrictMode>,
);
