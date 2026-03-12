#[cfg(target_os = "macos")]
use std::ffi::c_void;
#[cfg(target_os = "macos")]
use std::ffi::{CStr, CString};
#[cfg(target_os = "macos")]
use std::os::raw::c_char;
#[cfg(target_os = "macos")]
use tokio::sync::oneshot;
#[cfg(target_os = "macos")]
use tokio::time::{Duration, timeout};

#[cfg(target_os = "macos")]
unsafe extern "C" {
    fn claude_desk_notifications_init() -> bool;
    fn claude_desk_send_notification_async(
        title: *const c_char,
        body: *const c_char,
        context: *mut c_void,
        completion: unsafe extern "C" fn(bool, *const c_char, *mut c_void),
    );
}

#[cfg(target_os = "macos")]
pub fn initialize() -> Result<(), String> {
    let initialized = unsafe { claude_desk_notifications_init() };
    if initialized {
        Ok(())
    } else {
        Err("Failed to initialize macOS notification center".to_string())
    }
}

#[cfg(not(target_os = "macos"))]
pub fn initialize() -> Result<(), String> {
    Ok(())
}

#[cfg(target_os = "macos")]
struct PendingResponse {
    sender: Option<oneshot::Sender<Result<bool, String>>>,
}

#[cfg(target_os = "macos")]
unsafe extern "C" fn handle_notification_completion(
    success: bool,
    error: *const c_char,
    context: *mut c_void,
) {
    let mut pending = unsafe { Box::from_raw(context.cast::<PendingResponse>()) };
    let result = if error.is_null() {
        Ok(success)
    } else {
        Err(unsafe { CStr::from_ptr(error) }
            .to_string_lossy()
            .into_owned())
    };

    if let Some(sender) = pending.sender.take() {
        let _ = sender.send(result);
    }
}

#[cfg(target_os = "macos")]
async fn await_native_result(
    start: impl FnOnce(*mut c_void, unsafe extern "C" fn(bool, *const c_char, *mut c_void)),
) -> Result<bool, String> {
    let (sender, receiver) = oneshot::channel();
    let context = Box::into_raw(Box::new(PendingResponse {
        sender: Some(sender),
    })) as *mut c_void;

    start(context, handle_notification_completion);

    match timeout(Duration::from_secs(2), receiver).await {
        Ok(Ok(result)) => result,
        Ok(Err(_)) => Err("Notification callback dropped".to_string()),
        Err(_) => Err("Timed out scheduling macOS notification".to_string()),
    }
}

#[cfg(not(target_os = "macos"))]
async fn await_native_result(
    _start: impl FnOnce(*mut c_void, unsafe extern "C" fn(bool, *const c_char, *mut c_void)),
) -> Result<bool, String> {
    Ok(false)
}

#[cfg(target_os = "macos")]
pub async fn send_notification(title: &str, body: &str) -> Result<bool, String> {
    let title = CString::new(title).map_err(|error| error.to_string())?;
    let body = CString::new(body).map_err(|error| error.to_string())?;
    await_native_result(|context, completion| unsafe {
        claude_desk_send_notification_async(title.as_ptr(), body.as_ptr(), context, completion);
    })
    .await
}

#[cfg(not(target_os = "macos"))]
pub async fn send_notification(_title: &str, _body: &str) -> Result<bool, String> {
    Ok(false)
}
