import { FileToolboxWindow } from "./components/FileToolboxWindow";
import "./styles.css";

function FileToolboxApp() {
  return (
    <div
      className="h-screen w-screen"
      style={{
        backgroundColor: "#1e1e1e",
        margin: 0,
        padding: 0,
        height: "100vh",
        width: "100vw",
      }}
    >
      <FileToolboxWindow />
    </div>
  );
}

export default FileToolboxApp;

