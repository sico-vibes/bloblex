use std::io;
use tokio::{
    io::AsyncWriteExt,
    process::{Child, ChildStdin, Command},
    sync::mpsc,
    task::JoinHandle,
    time::{timeout, Duration},
};
use std::process::Command as StdCommand;

/// Starts each child in an isolated process group where the platform supports it.
pub fn prepare_command(command: &mut Command) {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.as_std_mut().process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.as_std_mut().creation_flags(0x0000_0004);
    }
    #[cfg(not(any(unix, windows)))]
    let _ = command;
}

/// Configures a standard-library child with the same process-tree guarantees.
pub fn prepare_std_command(command: &mut StdCommand) {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0000_0004);
    }
}

/// Owns the provider process tree. Windows descendants are killed when the job
/// handle closes; Unix descendants share the child process group.
pub struct ProcessTree {
    #[cfg(unix)]
    process_group: i32,
    #[cfg(windows)]
    job: isize,
}

/// Serializes child stdin through an independent writer task so adapter event
/// readers continue draining stdout and stderr while a child is not reading.
pub struct StdinWriter {
    sender: Option<mpsc::Sender<Vec<u8>>>,
    task: JoinHandle<()>,
}

impl StdinWriter {
    pub fn new(mut stdin: ChildStdin) -> Self {
        let (sender, mut receiver) = mpsc::channel::<Vec<u8>>(32);
        let task = tokio::spawn(async move {
            while let Some(bytes) = receiver.recv().await {
                if stdin.write_all(&bytes).await.is_err() {
                    break;
                }
                if stdin.flush().await.is_err() {
                    break;
                }
            }
        });
        Self {
            sender: Some(sender),
            task,
        }
    }

    /// Queue a write without waiting on a potentially blocked OS pipe.
    pub async fn write(&self, bytes: &[u8]) -> io::Result<()> {
        let sender = self.sender.as_ref().ok_or_else(|| {
            io::Error::new(io::ErrorKind::BrokenPipe, "child stdin is closed")
        })?;
        sender.try_send(bytes.to_vec()).map_err(|error| {
            io::Error::new(io::ErrorKind::WouldBlock, error.to_string())
        })
    }

    /// Close stdin, allow the child a short graceful exit, then kill its whole
    /// owned tree and wait for the direct child if it does not exit in time.
    pub async fn close(&mut self, child: &mut Child, tree: &ProcessTree) {
        self.sender.take();
        if timeout(Duration::from_millis(500), &mut self.task)
            .await
            .is_err()
        {
            let _ = tree.terminate();
            let _ = child.kill().await;
            let _ = timeout(Duration::from_secs(2), child.wait()).await;
            return;
        }
        if timeout(Duration::from_millis(500), child.wait())
            .await
            .is_err()
        {
            let _ = tree.terminate();
            let _ = child.kill().await;
            let _ = timeout(Duration::from_secs(2), child.wait()).await;
        }
    }
}

impl ProcessTree {
    pub fn attach(child: &mut Child) -> io::Result<Self> {
        let process_id = child.id().ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "child process has exited"))?;
        match Self::attach_process_id(process_id) {
            Ok(tree) => Ok(tree),
            Err(error) => {
                let _ = child.start_kill();
                Err(error)
            }
        }
    }

    /// Attaches a process created outside Tokio to the same platform tree owner.
    /// On Unix, callers must have placed the process in its own group first.
    pub fn attach_process_id(process_id: u32) -> io::Result<Self> {
        #[cfg(unix)]
        {
            Ok(Self { process_group: process_id as i32 })
        }
        #[cfg(windows)]
        {
            use std::{mem::size_of, ptr};
            use windows_sys::Win32::{
                Foundation::CloseHandle,
                System::{
                    JobObjects::{AssignProcessToJobObject, CreateJobObjectW, JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JobObjectExtendedLimitInformation, SetInformationJobObject},
                    Threading::{OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE},
                },
            };
            unsafe {
                let job = CreateJobObjectW(ptr::null(), ptr::null());
                if job.is_null() { return Err(io::Error::last_os_error()); }
                let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
                limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                let configured = SetInformationJobObject(
                    job,
                    JobObjectExtendedLimitInformation,
                    &limits as *const _ as *const _,
                    size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                );
                if configured == 0 {
                    let error = io::Error::last_os_error();
                    CloseHandle(job);
                    return Err(error);
                }
                let process = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, process_id);
                if process.is_null() {
                    let error = io::Error::last_os_error();
                    CloseHandle(job);
                    return Err(error);
                }
                let assigned = AssignProcessToJobObject(job, process);
                CloseHandle(process);
                if assigned == 0 {
                    let error = io::Error::last_os_error();
                    CloseHandle(job);
                    return Err(error);
                }
                if let Err(error) = resume_primary_thread(process_id) {
                    let _ = windows_sys::Win32::System::JobObjects::TerminateJobObject(job, 1);
                    CloseHandle(job);
                    return Err(error);
                }
                Ok(Self { job: job as isize })
            }
        }
        #[cfg(not(any(unix, windows)))]
        {
            let _ = process_id;
            Ok(Self {})
        }
    }

    /// Force-terminates the entire owned tree.
    pub fn terminate(&self) -> io::Result<()> {
        #[cfg(unix)]
        {
            // `prepare_command` places the child in a process group named for its pid.
            unsafe extern "C" { fn kill(pid: i32, signal: i32) -> i32; }
            let result = unsafe { kill(-self.process_group, 9) };
            if result == 0 { return Ok(()); }
            let error = io::Error::last_os_error();
            if error.raw_os_error() == Some(3) { return Ok(()); }
            return Err(error);
        }
        #[cfg(windows)]
        {
            use windows_sys::Win32::System::JobObjects::TerminateJobObject;
            let result = unsafe { TerminateJobObject(self.job as _, 1) };
            if result != 0 { Ok(()) } else { Err(io::Error::last_os_error()) }
        }
        #[cfg(not(any(unix, windows)))]
        { Ok(()) }
    }
}

#[cfg(windows)]
fn resume_primary_thread(process_id: u32) -> io::Result<()> {
    use windows_sys::Win32::{
        Foundation::CloseHandle,
        System::Diagnostics::ToolHelp::{
            CreateToolhelp32Snapshot, Thread32First, Thread32Next, THREADENTRY32,
            TH32CS_SNAPTHREAD,
        },
        System::Threading::{OpenThread, ResumeThread, THREAD_SUSPEND_RESUME},
    };
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
        if snapshot.is_null() {
            return Err(io::Error::last_os_error());
        }
        let mut entry: THREADENTRY32 = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<THREADENTRY32>() as u32;
        let mut found = Thread32First(snapshot, &mut entry) != 0;
        while found && entry.th32OwnerProcessID != process_id {
            found = Thread32Next(snapshot, &mut entry) != 0;
        }
        CloseHandle(snapshot);
        if !found {
            return Err(io::Error::new(io::ErrorKind::NotFound, "suspended process thread was not found"));
        }
        let thread = OpenThread(THREAD_SUSPEND_RESUME, 0, entry.th32ThreadID);
        if thread.is_null() {
            return Err(io::Error::last_os_error());
        }
        let resumed = ResumeThread(thread);
        CloseHandle(thread);
        if resumed == u32::MAX {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }
}

impl Drop for ProcessTree {
    fn drop(&mut self) {
        #[cfg(windows)]
        unsafe {
            use windows_sys::Win32::Foundation::CloseHandle;
            if self.job != 0 { CloseHandle(self.job as _); }
        }
        #[cfg(unix)]
        { let _ = self.terminate(); }
    }
}
