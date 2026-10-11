// Preloaded into the web server by run-local.sh when HOST lists more than one
// address. Next's standalone server binds a single address, so once it is
// listening this accepts connections on the other addresses (same port) and
// hands them to the same HTTP server, without running another process.
import http from "node:http";
import net from "node:net";

const hosts = (process.env.ALSO_LISTEN_HOSTS ?? "").split(",").filter(Boolean);
const listen = http.Server.prototype.listen;
let patched = false;

http.Server.prototype.listen = function (...args) {
  if (!patched && hosts.length > 0) {
    patched = true;
    this.once("listening", () => {
      const { port } = this.address();
      for (const host of hosts) {
        net
          .createServer((socket) => this.emit("connection", socket))
          .on("error", (err) => {
            console.error(`Failed to also listen on ${host}:${port}:`, err);
            process.exit(1);
          })
          .listen(port, host);
      }
    });
  }
  return listen.apply(this, args);
};
