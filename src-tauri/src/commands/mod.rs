pub mod accounts;
pub mod securities;
pub mod transactions;
pub mod prices;
pub mod snapshots;
pub mod simplefin;
pub mod budget;
pub mod market;
pub mod backup;
pub mod copilot;
pub mod devicesync;
pub mod goals;
pub mod recurring;

/// Run slow work — anything that touches the network — on a worker thread.
///
/// Tauri runs a plain `fn` command on the main thread, the same thread that
/// draws the window, so a blocking download there freezes the whole app until
/// it returns. Commands that fetch are `async` and hand their work to this.
pub async fn off_main_thread<T, F>(work: F) -> Result<T, String>
where
    F: FnOnce() -> Result<T, String> + Send + 'static,
    T: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slow_work_runs_on_a_worker_thread_not_the_callers() {
        let caller = std::thread::current().id();
        let ran_on = tauri::async_runtime::block_on(off_main_thread(|| {
            Ok::<_, String>(std::thread::current().id())
        }))
        .unwrap();
        assert_ne!(ran_on, caller);
    }

    #[test]
    fn an_error_from_the_work_reaches_the_caller_unchanged() {
        let result = tauri::async_runtime::block_on(off_main_thread(|| {
            Err::<(), _>("Couldn't reach SimpleFIN.".to_string())
        }));
        assert_eq!(result, Err("Couldn't reach SimpleFIN.".to_string()));
    }
}
