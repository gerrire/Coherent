use wasm_bindgen::prelude::*;
use zeroize::Zeroize;

use crate::engine::CryptoEngine;

/// Instantiate only inside the browser crypto Worker. Local snapshots are
/// sealed with a nonextractable Web Crypto key before writing IndexedDB.
#[wasm_bindgen]
pub struct BrowserCrypto {
    engine: CryptoEngine,
}

#[wasm_bindgen]
impl BrowserCrypto {
    #[wasm_bindgen(constructor)]
    pub fn new(account_id: &str, device_id: &str) -> Result<BrowserCrypto, JsError> {
        Ok(Self {
            engine: CryptoEngine::new(account_id, device_id)
                .map_err(|e| JsError::new(&e.to_string()))?,
        })
    }

    pub fn restore(mut bytes: Vec<u8>) -> Result<BrowserCrypto, JsError> {
        let result = CryptoEngine::restore_local(&bytes);
        bytes.zeroize();
        Ok(Self {
            engine: result.map_err(|e| JsError::new(&e.to_string()))?,
        })
    }

    pub fn execute(&mut self, mut command: String) -> Result<String, JsError> {
        let result = self.engine.execute_json(&command);
        command.zeroize();
        result.map_err(|e| JsError::new(&e.to_string()))
    }

    pub fn snapshot_local(&self) -> Result<Vec<u8>, JsError> {
        Ok(self
            .engine
            .snapshot_local()
            .map_err(|e| JsError::new(&e.to_string()))?
            .to_vec())
    }
}
