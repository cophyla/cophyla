//! The local addresses worth a host candidate: every address of an interface that is up,
//! but loopback, link-local, carrier-grade NAT space, unique-local IPv6, and whatever a
//! virtual switch, a VPN or a container network holds. A phone off the LAN cannot reach
//! those, and a candidate there leaks an address and wastes checks.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

/// What the gathering may take beside the always-usable addresses.
#[derive(Clone, Debug, Default)]
pub struct GatherOptions {
    pub ipv6: bool,
    pub loopback: bool,
    /// Interface names left out by the user, matched case-insensitively as prefixes.
    pub skip: Vec<String>,
}

/// Interface names that are virtual, a VPN's, or a container's, by prefix (case-insensitive).
const VIRTUAL: &[&str] = &[
    "vethernet", "vmware", "virtualbox", "vbox", "hyper-v", "docker", "br-", "veth", "virbr", "vmnet", "vboxnet", "utun", "tailscale", "zerotier", "npcap", "loopback", "bluetooth", "ipsec", "awdl", "anpi", "bridge", "cni", "flannel", "cali", "kube", "lxc", "lxd", "podman", "nordlynx", "proton", "mullvad", "openvpn", "wintun", "hamachi", "radmin", "teredo", "isatap",
];

/// Short Unix names that only count followed by a unit number: `lo0`, `tun0`, `wg0`, never `Local Area Connection`.
const NUMBERED: &[&str] = &["lo", "tun", "tap", "wg", "zt", "gif", "stf", "ppp", "llw"];

/// Whether an interface name is one of the virtual, VPN or container kinds, or one the user
/// left out; `*` leaves every one out (loopback alone remains, for a test).
pub fn skipped_interface(name: &str, skip: &[String]) -> bool {
    if skip.iter().any(|s| s == "*") {
        return true;
    }
    let lower = name.to_ascii_lowercase();
    let numbered = NUMBERED.iter().any(|p| lower.strip_prefix(p).is_some_and(|rest| rest.is_empty() || rest.starts_with(|c: char| c.is_ascii_digit())));
    numbered || VIRTUAL.iter().any(|p| lower.starts_with(p)) || skip.iter().any(|s| !s.is_empty() && lower.starts_with(&s.to_ascii_lowercase()))
}

fn v4_usable(ip: Ipv4Addr, loopback: bool) -> bool {
    if ip.is_loopback() {
        return loopback;
    }
    let o = ip.octets();
    let cgn = o[0] == 100 && (o[1] & 0xc0) == 64;
    !(ip.is_unspecified() || ip.is_link_local() || ip.is_multicast() || ip.is_broadcast() || ip.is_documentation() || cgn || o[0] == 0)
}

fn v6_usable(ip: Ipv6Addr, loopback: bool) -> bool {
    if ip.is_loopback() {
        return loopback;
    }
    // Global unicast only: 2000::/3, without documentation, Teredo and 6to4. Unique-local
    // and link-local reach no phone off the LAN; the tunnels are the OS's, not a path.
    let s = ip.segments();
    (s[0] & 0xe000) == 0x2000 && !(s[0] == 0x2001 && (s[1] == 0x0db8 || s[1] == 0)) && s[0] != 0x2002
}

/// Whether an address is worth a host candidate under these options.
pub fn usable(ip: IpAddr, opts: &GatherOptions) -> bool {
    match ip {
        IpAddr::V4(v4) => v4_usable(v4, opts.loopback),
        IpAddr::V6(v6) => (opts.ipv6 || (opts.loopback && v6.is_loopback())) && v6_usable(v6, opts.loopback),
    }
}

/// Whether an IPv6 address is a global one: what `net.state` reports as `ipv6`.
pub fn is_global_v6(ip: IpAddr) -> bool {
    matches!(ip, IpAddr::V6(v6) if !v6.is_loopback() && v6_usable(v6, false))
}

/// The usable addresses of the interfaces that are up now, IPv4 first, each once.
pub async fn local_addresses(opts: &GatherOptions) -> Vec<IpAddr> {
    let state = netwatch::interfaces::State::new().await;
    let mut out: Vec<IpAddr> = Vec::new();
    let mut names: Vec<&String> = state.interfaces.keys().collect();
    names.sort();
    for name in names {
        let iface = &state.interfaces[name];
        if !iface.is_up() {
            continue;
        }
        let is_loopback_iface = iface.addrs().all(|n| n.addr().is_loopback());
        if !(opts.loopback && is_loopback_iface) && skipped_interface(iface.name(), &opts.skip) {
            continue;
        }
        for net in iface.addrs() {
            let ip = net.addr();
            if usable(ip, opts) && !out.contains(&ip) {
                out.push(ip);
            }
        }
    }
    if opts.loopback && !out.iter().any(|ip| ip.is_loopback()) {
        out.push(IpAddr::V4(Ipv4Addr::LOCALHOST));
    }
    out.sort_by_key(|ip| (ip.is_ipv6(), ip.is_loopback()));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn opts() -> GatherOptions {
        GatherOptions { ipv6: true, loopback: false, skip: vec![] }
    }

    #[test]
    fn private_and_public_v4_are_usable() {
        for a in ["192.168.1.44", "10.0.0.5", "172.16.3.1", "81.2.69.160"] {
            assert!(usable(a.parse().unwrap(), &opts()), "{a}");
        }
    }

    #[test]
    fn loopback_link_local_and_cgn_are_not() {
        for a in ["127.0.0.1", "169.254.10.1", "100.64.0.1", "100.127.255.254", "0.0.0.0", "224.0.0.1", "255.255.255.255"] {
            assert!(!usable(a.parse().unwrap(), &opts()), "{a}");
        }
        assert!(usable("100.128.0.1".parse().unwrap(), &opts()));
        assert!(usable("127.0.0.1".parse().unwrap(), &GatherOptions { loopback: true, ..opts() }));
    }

    #[test]
    fn only_global_v6() {
        assert!(usable("2a02:1234::1".parse().unwrap(), &opts()));
        for a in ["fe80::1", "fd00::1", "::1", "ff02::1", "2001:db8::1", "::", "2001:0:4136::1", "2002:c000:204::1"] {
            assert!(!usable(a.parse().unwrap(), &opts()), "{a}");
        }
        assert!(!usable("2a02:1234::1".parse().unwrap(), &GatherOptions { ipv6: false, ..opts() }));
        assert!(is_global_v6("2a02:1234::1".parse().unwrap()));
        assert!(!is_global_v6("fd00::1".parse().unwrap()));
    }

    #[test]
    fn virtual_and_vpn_interfaces_are_skipped() {
        for n in ["vEthernet (WSL)", "VMware Network Adapter VMnet8", "docker0", "tailscale0", "wg0", "utun3", "ZeroTier One", "Loopback Pseudo-Interface 1", "NordLynx"] {
            assert!(skipped_interface(n, &[]), "{n}");
        }
        for n in ["Ethernet 2", "Wi-Fi", "en0", "eth0", "wlan0", "enp3s0", "Local Area Connection", "tapestry", "wlp2s0"] {
            assert!(!skipped_interface(n, &[]), "{n}");
        }
        for n in ["lo", "lo0", "tun0", "wg1", "ppp0"] {
            assert!(skipped_interface(n, &[]), "{n}");
        }
        assert!(skipped_interface("Ethernet 3", &["ethernet 3".to_string()]));
    }
}
