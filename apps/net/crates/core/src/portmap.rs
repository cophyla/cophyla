//! A mapping of the helper's port on the home router, through n0's `portmapper` (UPnP IGD,
//! NAT-PMP, PCP, whichever the router answers). With one, the node is reachable from any
//! phone NAT, the random-port ones included; without, nothing changes. More ports can be
//! mapped the same way (the desktop stream's), one client each. IPv4 only.

use std::net::SocketAddrV4;
use std::num::NonZeroU16;

use portmapper::{Client, Config};
use tokio::sync::watch;

pub struct PortMap {
    port: u16,
    client: Client,
    rx: watch::Receiver<Option<SocketAddrV4>>,
    extra: Vec<(u16, Client)>,
}

impl PortMap {
    /// Starts keeping a mapping for `port`.
    pub fn start(port: u16) -> PortMap {
        let client = Client::new(Config::default());
        if let Some(p) = NonZeroU16::new(port) {
            client.update_local_port(p);
        }
        client.procure_mapping();
        let rx = client.watch_external_address();
        PortMap { port, client, rx, extra: Vec::new() }
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    /// The router's public address for the port, once mapped.
    pub fn external(&self) -> Option<SocketAddrV4> {
        *self.rx.borrow()
    }

    /// A receiver of the external address, for the core's loop.
    pub fn watch(&self) -> watch::Receiver<Option<SocketAddrV4>> {
        self.rx.clone()
    }

    /// Which protocols the router answers, asked once; empty when none or on error.
    pub async fn probe(&self) -> Vec<String> {
        let Ok(Ok(out)) = self.client.probe().await else { return Vec::new() };
        let mut v = Vec::new();
        if out.upnp {
            v.push("upnp".to_string());
        }
        if out.pcp {
            v.push("pcp".to_string());
        }
        if out.nat_pmp {
            v.push("nat-pmp".to_string());
        }
        v
    }

    /// Keeps mappings for these ports too, replacing the extra ones before.
    pub fn map_extra(&mut self, ports: &[u16]) -> Vec<u16> {
        self.extra.retain(|(p, c)| {
            let keep = ports.contains(p);
            if !keep {
                c.deactivate();
            }
            keep
        });
        for &p in ports {
            if p == self.port || self.extra.iter().any(|(q, _)| *q == p) {
                continue;
            }
            let Some(nz) = NonZeroU16::new(p) else { continue };
            let c = Client::new(Config::default());
            c.update_local_port(nz);
            c.procure_mapping();
            self.extra.push((p, c));
        }
        self.extra.iter().map(|(p, _)| *p).collect()
    }

    pub fn stop(&mut self) {
        self.client.deactivate();
        for (_, c) in self.extra.drain(..) {
            c.deactivate();
        }
    }
}

impl Drop for PortMap {
    fn drop(&mut self) {
        self.stop();
    }
}
