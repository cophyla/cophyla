//! cophylad cuts every sealed record into data-channel messages (`packages/relay/src/chunk.ts`);
//! the helper takes messages of `MAX_FRAME` at most. The TypeScript side's vectors say which
//! size it cuts to, so the two cannot drift apart.

use net_proto::MAX_FRAME;
use serde_json::Value;

#[test]
fn cophylad_cuts_to_the_size_the_helper_takes() {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../../packages/relay/test/chunk-vectors.json");
    let text = std::fs::read_to_string(path).expect("the relay package's chunk vectors");
    let v: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(v["chunkMax"].as_u64(), Some(MAX_FRAME as u64));
    for vector in v["vectors"].as_array().unwrap() {
        let max = vector["max"].as_u64().unwrap() as usize;
        for m in vector["messages"].as_array().unwrap() {
            let m = m.as_str().unwrap();
            assert!(m.len() <= max, "{m:?} is over {max}");
            assert!(m.starts_with('+') || m.starts_with('='), "{m:?} has no marker");
        }
    }
}
