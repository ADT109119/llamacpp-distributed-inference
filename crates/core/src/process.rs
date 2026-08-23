use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Child;
use tokio::sync::mpsc::UnboundedSender;

/// 將子進程 stdout/stderr 逐行轉發至 channel。
/// stdout → ("out", line)，stderr → ("err", line)。
pub fn pipe_output(child: &mut Child, tx: UnboundedSender<(&'static str, String)>) {
    let stdout = child.stdout.take().expect("child stdout");
    let stderr = child.stderr.take().expect("child stderr");

    let tx_out = tx.clone();
    tokio::spawn(async move {
        let reader = BufReader::new(stdout);
        let mut lines = reader.lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if tx_out.send(("out", line)).is_err() {
                break;
            }
        }
    });

    tokio::spawn(async move {
        let reader = BufReader::new(stderr);
        let mut lines = reader.lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if tx.send(("err", line)).is_err() {
                break;
            }
        }
    });
}
