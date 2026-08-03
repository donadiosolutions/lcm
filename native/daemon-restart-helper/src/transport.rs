//! Bounded, descriptor-only transport for the initial zero-session router.

use crate::protocol::{self, Frame, HEADER_LEN, MAX_PAYLOAD_LEN, MessageKind, RequestKind};
use crate::syscall::{self, Errno};
use std::os::fd::RawFd;

pub const OPEN_STABLE_FRAME_DEADLINE_MS: u64 = 10_000;
const MAX_FRAME_LEN: usize = HEADER_LEN + MAX_PAYLOAD_LEN;
const READ_CHUNK: usize = 4096;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TransportError {
    Io,
    Timeout,
    Protocol,
    Entropy,
    Unsupported,
}

/// The only two routes the version-1 zero-session router may select.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum RouterRoute {
    OpenStable,
    ResumeActive,
}

/// A complete, structurally valid zero-session router request.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct RouterRequest {
    pub route: RouterRoute,
    pub request_id: [u8; 32],
}

/// Admission owns the point at which fresh session entropy is acquired.  This makes it possible
/// to obtain entropy after a route's first exact layout check but before its final postcheck.
pub(crate) trait AdmissionGate {
    fn check_deadline(&mut self) -> Result<(), TransportError>;
    fn fresh_session_id(&mut self) -> Result<[u8; 32], TransportError>;
}

/// A response paired with every authority retained by its selected route.  The lease is held
/// until the bounded response write has completed or failed.
pub(crate) struct AdmittedResponse<L> {
    bytes: Vec<u8>,
    _lease: L,
}

impl<L> AdmittedResponse<L> {
    pub(crate) fn new(bytes: Vec<u8>, lease: L) -> Self {
        Self {
            bytes,
            _lease: lease,
        }
    }
}

trait Io {
    fn now_millis(&mut self) -> Result<u64, Errno>;
    fn wait(&mut self, writable: bool, timeout_ms: i32) -> Result<bool, Errno>;
    fn read(&mut self, bytes: &mut [u8]) -> Result<usize, Errno>;
    fn write(&mut self, bytes: &[u8]) -> Result<usize, Errno>;
    fn random(&mut self, bytes: &mut [u8]) -> Result<(), Errno>;
}

struct LinuxIo {
    input: RawFd,
    output: RawFd,
}
impl Io for LinuxIo {
    fn now_millis(&mut self) -> Result<u64, Errno> {
        syscall::monotonic_millis()
    }
    fn wait(&mut self, writable: bool, timeout_ms: i32) -> Result<bool, Errno> {
        syscall::wait_for_io(
            if writable { self.output } else { self.input },
            writable,
            timeout_ms,
        )
    }
    fn read(&mut self, bytes: &mut [u8]) -> Result<usize, Errno> {
        syscall::read_some(self.input, bytes)
    }
    fn write(&mut self, bytes: &[u8]) -> Result<usize, Errno> {
        syscall::write_some(self.output, bytes)
    }
    fn random(&mut self, bytes: &mut [u8]) -> Result<(), Errno> {
        syscall::random_fill(bytes)
    }
}

fn remaining<I: Io>(io: &mut I, deadline: u64) -> Result<i32, TransportError> {
    let now = io.now_millis().map_err(classify_io_error)?;
    let remaining = deadline.checked_sub(now).ok_or(TransportError::Timeout)?;
    if remaining == 0 {
        return Err(TransportError::Timeout);
    }
    i32::try_from(remaining).map_err(|_| TransportError::Io)
}

fn classify_io_error(error: Errno) -> TransportError {
    if error == Errno::ENOSYS {
        TransportError::Unsupported
    } else {
        TransportError::Io
    }
}

fn read_frame<I: Io>(
    io: &mut I,
    deadline: u64,
    pending: &mut Vec<u8>,
) -> Result<Frame, TransportError> {
    loop {
        if pending.len() >= HEADER_LEN {
            let length = protocol::frame_length_from_header(&pending[..HEADER_LEN])
                .map_err(|_| TransportError::Protocol)?;
            if pending.len() >= length {
                let frame =
                    Frame::decode(&pending[..length]).map_err(|_| TransportError::Protocol)?;
                pending.drain(..length);
                return Ok(frame);
            }
        }
        if pending.len() >= MAX_FRAME_LEN + READ_CHUNK {
            return Err(TransportError::Protocol);
        }
        let timeout = remaining(io, deadline)?;
        match io.wait(false, timeout) {
            Ok(false) => return Err(TransportError::Timeout),
            Ok(true) => {}
            Err(Errno::EINTR) => continue,
            Err(error) => return Err(classify_io_error(error)),
        }
        let mut chunk = [0_u8; READ_CHUNK];
        match io.read(&mut chunk) {
            Ok(0) => return Err(TransportError::Protocol),
            Ok(count) if count <= chunk.len() => pending.extend_from_slice(&chunk[..count]),
            Ok(_) => return Err(TransportError::Io),
            Err(Errno::EAGAIN | Errno::EINTR) => continue,
            Err(error) => return Err(classify_io_error(error)),
        }
    }
}

fn write_all<I: Io>(io: &mut I, deadline: u64, bytes: &[u8]) -> Result<(), TransportError> {
    let mut offset = 0;
    while offset < bytes.len() {
        let timeout = remaining(io, deadline)?;
        match io.wait(true, timeout) {
            Ok(false) => return Err(TransportError::Timeout),
            Ok(true) => {}
            Err(Errno::EINTR) => continue,
            Err(error) => return Err(classify_io_error(error)),
        }
        match io.write(&bytes[offset..]) {
            Ok(0) => return Err(TransportError::Io),
            Ok(count) if count <= bytes.len() - offset => offset += count,
            Ok(_) => return Err(TransportError::Io),
            Err(Errno::EAGAIN | Errno::EINTR) => continue,
            Err(error) => return Err(classify_io_error(error)),
        }
    }
    Ok(())
}

fn router_request(frame: Frame) -> Result<RouterRequest, TransportError> {
    let route = match frame.kind {
        MessageKind::Request(RequestKind::OpenStable) => RouterRoute::OpenStable,
        MessageKind::Request(RequestKind::ResumeActive) => RouterRoute::ResumeActive,
        _ => return Err(TransportError::Protocol),
    };
    if frame.session_id.iter().any(|byte| *byte != 0)
        || frame.ordinal != 0
        || frame.request_id.iter().all(|byte| *byte == 0)
        || !frame.payload.is_empty()
    {
        return Err(TransportError::Protocol);
    }
    Ok(RouterRequest {
        route,
        request_id: frame.request_id,
    })
}

struct RouterGate<'a, I> {
    io: &'a mut I,
    deadline: u64,
}

impl<I: Io> AdmissionGate for RouterGate<'_, I> {
    fn check_deadline(&mut self) -> Result<(), TransportError> {
        remaining(self.io, self.deadline).map(|_| ())
    }

    fn fresh_session_id(&mut self) -> Result<[u8; 32], TransportError> {
        self.check_deadline()?;
        let mut session_id = [0_u8; 32];
        self.io.random(&mut session_id).map_err(|error| {
            if error == Errno::ENOSYS {
                TransportError::Unsupported
            } else {
                TransportError::Entropy
            }
        })?;
        if session_id.iter().all(|byte| *byte == 0) {
            return Err(TransportError::Entropy);
        }
        self.check_deadline()?;
        Ok(session_id)
    }
}

fn serve_router_with<I: Io, F, L>(io: &mut I, admit: F) -> Result<(), TransportError>
where
    F: FnOnce(RouterRequest, &mut dyn AdmissionGate) -> Result<AdmittedResponse<L>, TransportError>,
{
    let start = io.now_millis().map_err(classify_io_error)?;
    let deadline = start
        .checked_add(OPEN_STABLE_FRAME_DEADLINE_MS)
        .ok_or(TransportError::Io)?;
    let mut pending = Vec::with_capacity(MAX_FRAME_LEN + READ_CHUNK);
    let request = router_request(read_frame(io, deadline, &mut pending)?)?;
    let mut gate = RouterGate { io, deadline };
    // Check on both sides of durable admission.  The selected admission performs its final
    // revalidation only after it obtains entropy through this gate.
    gate.check_deadline()?;
    let response = admit(request, &mut gate)?;
    gate.check_deadline()?;
    write_all(gate.io, gate.deadline, &response.bytes)
}

pub(crate) fn serve_router<F, L>(admit: F) -> Result<(), TransportError>
where
    F: FnOnce(RouterRequest, &mut dyn AdmissionGate) -> Result<AdmittedResponse<L>, TransportError>,
{
    serve_router_with(
        &mut LinuxIo {
            input: 0,
            output: 1,
        },
        admit,
    )
}

#[cfg(test)]
fn serve_with<I: Io>(io: &mut I) -> Result<(), TransportError> {
    serve_router_with(io, |request, gate| {
        if request.route != RouterRoute::OpenStable {
            return Err(TransportError::Protocol);
        }
        let session_id = gate.fresh_session_id()?;
        let bytes = protocol::open_stable_response(request.request_id, session_id)
            .map_err(|_| TransportError::Protocol)?;
        Ok(AdmittedResponse::new(bytes, ()))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{Frame, MessageKind};
    struct Fake {
        now: u64,
        input: Vec<u8>,
        read_at: usize,
        read_limit: usize,
        output: Vec<u8>,
        waits: Vec<bool>,
        wait_result: bool,
        write_error_after: Option<usize>,
        write_calls: usize,
        random: [u8; 32],
        random_error: Option<Errno>,
    }
    impl Io for Fake {
        fn now_millis(&mut self) -> Result<u64, Errno> {
            Ok(self.now)
        }
        fn wait(&mut self, writable: bool, _timeout: i32) -> Result<bool, Errno> {
            self.waits.push(writable);
            Ok(self.wait_result)
        }
        fn read(&mut self, bytes: &mut [u8]) -> Result<usize, Errno> {
            let count = (self.input.len() - self.read_at)
                .min(self.read_limit)
                .min(bytes.len());
            bytes[..count].copy_from_slice(&self.input[self.read_at..self.read_at + count]);
            self.read_at += count;
            Ok(count)
        }
        fn write(&mut self, bytes: &[u8]) -> Result<usize, Errno> {
            if self.write_error_after == Some(self.write_calls) {
                return Err(Errno(32));
            }
            self.write_calls += 1;
            let count = bytes.len().min(19);
            self.output.extend_from_slice(&bytes[..count]);
            Ok(count)
        }
        fn random(&mut self, bytes: &mut [u8]) -> Result<(), Errno> {
            if let Some(error) = self.random_error {
                return Err(error);
            }
            bytes.copy_from_slice(&self.random);
            Ok(())
        }
    }

    struct TimedFake {
        times: Vec<u64>,
        time_index: usize,
        input: Vec<u8>,
        read_at: usize,
        output: Vec<u8>,
        random: [u8; 32],
        events: std::rc::Rc<std::cell::RefCell<Vec<&'static str>>>,
    }

    impl Io for TimedFake {
        fn now_millis(&mut self) -> Result<u64, Errno> {
            let value = self
                .times
                .get(self.time_index)
                .copied()
                .unwrap_or_else(|| *self.times.last().unwrap());
            self.time_index += 1;
            Ok(value)
        }
        fn wait(&mut self, writable: bool, _timeout: i32) -> Result<bool, Errno> {
            if writable {
                self.events.borrow_mut().push("write-ready");
            }
            Ok(true)
        }
        fn read(&mut self, bytes: &mut [u8]) -> Result<usize, Errno> {
            let count = (self.input.len() - self.read_at).min(bytes.len());
            bytes[..count].copy_from_slice(&self.input[self.read_at..self.read_at + count]);
            self.read_at += count;
            Ok(count)
        }
        fn write(&mut self, bytes: &[u8]) -> Result<usize, Errno> {
            self.events.borrow_mut().push("write");
            self.output.extend_from_slice(bytes);
            Ok(bytes.len())
        }
        fn random(&mut self, bytes: &mut [u8]) -> Result<(), Errno> {
            self.events.borrow_mut().push("entropy");
            bytes.copy_from_slice(&self.random);
            Ok(())
        }
    }
    fn request() -> Vec<u8> {
        request_for(RequestKind::OpenStable)
    }

    fn request_for(kind: RequestKind) -> Vec<u8> {
        Frame {
            kind: MessageKind::Request(kind),
            session_id: [0; 32],
            ordinal: 0,
            request_id: [7; 32],
            payload: Vec::new(),
        }
        .encode()
        .unwrap()
    }
    #[test]
    fn fragmented_request_yields_only_canonical_open_stable_response() {
        let mut io = Fake {
            now: 1,
            input: request(),
            read_at: 0,
            read_limit: 17,
            output: Vec::new(),
            waits: Vec::new(),
            wait_result: true,
            write_error_after: None,
            write_calls: 0,
            random: [3; 32],
            random_error: None,
        };
        assert_eq!(serve_with(&mut io), Ok(()));
        let response = Frame::decode(&io.output).unwrap();
        assert_eq!(
            response.kind,
            MessageKind::Response(RequestKind::OpenStable)
        );
        assert_eq!(response.session_id, [3; 32]);
        assert_eq!(response.ordinal, 0);
        assert_eq!(response.request_id, [7; 32]);
        assert_eq!(response.payload, vec![2, 0, 0, 0, 0, 0, 0, 0]);
    }

    #[test]
    fn router_selects_resume_active_and_retains_the_route_lease_until_write() {
        let mut io = Fake {
            now: 1,
            input: request_for(RequestKind::ResumeActive),
            read_at: 0,
            read_limit: 17,
            output: Vec::new(),
            waits: Vec::new(),
            wait_result: true,
            write_error_after: None,
            write_calls: 0,
            random: [4; 32],
            random_error: None,
        };
        let retained = std::cell::Cell::new(false);
        assert_eq!(
            serve_router_with(&mut io, |request, gate| {
                assert_eq!(request.route, RouterRoute::ResumeActive);
                let session_id = gate.fresh_session_id()?;
                let bytes = protocol::resume_active_response(request.request_id, session_id)
                    .map_err(|_| TransportError::Protocol)?;
                Ok(AdmittedResponse::new(bytes, &retained))
            }),
            Ok(())
        );
        retained.set(true);
        let response = Frame::decode(&io.output).unwrap();
        assert_eq!(
            response.kind,
            MessageKind::Response(RequestKind::ResumeActive)
        );
        assert_eq!(response.payload, vec![3, 0, 1, 0, 0, 0, 0, 0]);
    }

    #[test]
    fn malformed_truncated_and_unsupported_router_frames_never_invoke_admission_or_write() {
        let unsupported = request_for(RequestKind::Bootstrap);
        let mut malformed = request();
        malformed[88] ^= 1;
        let truncated = request()[..HEADER_LEN - 1].to_vec();
        for input in [unsupported, malformed, truncated] {
            let mut io = Fake {
                now: 1,
                input,
                read_at: 0,
                read_limit: READ_CHUNK,
                output: Vec::new(),
                waits: Vec::new(),
                wait_result: true,
                write_error_after: None,
                write_calls: 0,
                random: [3; 32],
                random_error: None,
            };
            let called = std::cell::Cell::new(false);
            assert_eq!(
                serve_router_with(&mut io, |_request, _gate| {
                    called.set(true);
                    Ok(AdmittedResponse::new(Vec::new(), ()))
                })
                .err(),
                Some(TransportError::Protocol)
            );
            assert!(!called.get());
            assert!(io.output.is_empty());
        }
    }

    #[test]
    fn entropy_precedes_final_postcheck_and_failure_never_writes_or_completes_admission() {
        let events = std::rc::Rc::new(std::cell::RefCell::new(Vec::new()));
        let mut io = TimedFake {
            times: vec![1; 16],
            time_index: 0,
            input: request(),
            read_at: 0,
            output: Vec::new(),
            random: [3; 32],
            events: events.clone(),
        };
        let final_postcheck = std::cell::Cell::new(false);
        assert_eq!(
            serve_router_with(&mut io, |_request, gate| {
                let _ = gate.fresh_session_id()?;
                events.borrow_mut().push("postcheck");
                final_postcheck.set(true);
                Ok(AdmittedResponse::new(vec![1], ()))
            }),
            Ok(())
        );
        assert_eq!(
            events.borrow().as_slice(),
            ["entropy", "postcheck", "write-ready", "write"]
        );
        assert!(final_postcheck.get());

        let mut failed = Fake {
            now: 1,
            input: request(),
            read_at: 0,
            read_limit: READ_CHUNK,
            output: Vec::new(),
            waits: Vec::new(),
            wait_result: true,
            write_error_after: None,
            write_calls: 0,
            random: [3; 32],
            random_error: Some(Errno::EAGAIN),
        };
        let postcheck_after_entropy = std::cell::Cell::new(false);
        assert_eq!(
            serve_router_with(&mut failed, |_request, gate| {
                let _ = gate.fresh_session_id()?;
                postcheck_after_entropy.set(true);
                Ok(AdmittedResponse::new(vec![1], ()))
            }),
            Err(TransportError::Entropy)
        );
        assert!(!postcheck_after_entropy.get());
        assert!(failed.output.is_empty());
    }

    #[test]
    fn shared_deadline_refuses_before_during_and_after_route_admission_without_writing() {
        let make = |times: Vec<u64>| TimedFake {
            times,
            time_index: 0,
            input: request(),
            read_at: 0,
            output: Vec::new(),
            random: [3; 32],
            events: std::rc::Rc::new(std::cell::RefCell::new(Vec::new())),
        };

        let mut before = make(vec![1, 1, 10_001]);
        let called = std::cell::Cell::new(false);
        assert_eq!(
            serve_router_with(&mut before, |_request, _gate| {
                called.set(true);
                Ok(AdmittedResponse::new(Vec::new(), ()))
            }),
            Err(TransportError::Timeout)
        );
        assert!(!called.get());
        assert!(before.output.is_empty());

        // Start, frame read, pre-admission check, entropy precheck, entropy postcheck.
        let mut during = make(vec![1, 1, 1, 1, 10_001]);
        let final_postcheck = std::cell::Cell::new(false);
        assert_eq!(
            serve_router_with(&mut during, |_request, gate| {
                let _ = gate.fresh_session_id()?;
                final_postcheck.set(true);
                Ok(AdmittedResponse::new(Vec::new(), ()))
            }),
            Err(TransportError::Timeout)
        );
        assert!(!final_postcheck.get());
        assert!(during.output.is_empty());

        // Start, frame read, pre-admission check, then the transport's required post-admission
        // deadline check. The route may have finalized, but it has no response capability.
        let mut after = make(vec![1, 1, 1, 10_001]);
        assert_eq!(
            serve_router_with(&mut after, |_request, _gate| {
                Ok(AdmittedResponse::new(vec![1], ()))
            }),
            Err(TransportError::Timeout)
        );
        assert!(after.output.is_empty());
    }
    #[test]
    fn malformed_or_unapproved_request_is_silent_failure() {
        let mut malformed = request();
        malformed[88] ^= 1;
        let mut io = Fake {
            now: 1,
            input: malformed,
            read_at: 0,
            read_limit: 17,
            output: Vec::new(),
            waits: Vec::new(),
            wait_result: true,
            write_error_after: None,
            write_calls: 0,
            random: [3; 32],
            random_error: None,
        };
        assert_eq!(serve_with(&mut io), Err(TransportError::Protocol));
        assert!(io.output.is_empty());
    }
    #[test]
    fn deadline_does_not_write() {
        let mut io = Fake {
            now: 1,
            input: request(),
            read_at: 0,
            read_limit: 17,
            output: Vec::new(),
            waits: Vec::new(),
            wait_result: false,
            write_error_after: None,
            write_calls: 0,
            random: [3; 32],
            random_error: None,
        };
        assert_eq!(serve_with(&mut io), Err(TransportError::Timeout));
        assert!(io.output.is_empty());
    }
    #[test]
    fn entropy_fault_does_not_write() {
        let mut io = Fake {
            now: 1,
            input: request(),
            read_at: 0,
            read_limit: 17,
            output: Vec::new(),
            waits: Vec::new(),
            wait_result: true,
            write_error_after: None,
            write_calls: 0,
            random: [0; 32],
            random_error: None,
        };
        assert_eq!(serve_with(&mut io), Err(TransportError::Entropy));
        assert!(io.output.is_empty());
    }
    #[test]
    fn coalesced_frames_leave_the_next_frame_buffered() {
        let mut input = request();
        input.extend(request());
        let mut io = Fake {
            now: 1,
            input,
            read_at: 0,
            read_limit: READ_CHUNK,
            output: Vec::new(),
            waits: Vec::new(),
            wait_result: true,
            write_error_after: None,
            write_calls: 0,
            random: [3; 32],
            random_error: None,
        };
        let mut pending = Vec::new();
        let deadline = 1 + OPEN_STABLE_FRAME_DEADLINE_MS;
        assert_eq!(
            read_frame(&mut io, deadline, &mut pending)
                .unwrap()
                .request_id,
            [7; 32]
        );
        assert_eq!(
            read_frame(&mut io, deadline, &mut pending)
                .unwrap()
                .request_id,
            [7; 32]
        );
        assert!(pending.is_empty());
    }
    #[test]
    fn entropy_interruption_and_unready_crng_are_silent() {
        for error in [Errno::EINTR, Errno::EAGAIN] {
            let mut io = Fake {
                now: 1,
                input: request(),
                read_at: 0,
                read_limit: 17,
                output: Vec::new(),
                waits: Vec::new(),
                wait_result: true,
                write_error_after: None,
                write_calls: 0,
                random: [3; 32],
                random_error: Some(error),
            };
            assert_eq!(serve_with(&mut io), Err(TransportError::Entropy));
            assert!(io.output.is_empty());
        }
    }
    #[test]
    fn unavailable_entropy_capability_is_silent_and_classified() {
        let mut io = Fake {
            now: 1,
            input: request(),
            read_at: 0,
            read_limit: 17,
            output: Vec::new(),
            waits: Vec::new(),
            wait_result: true,
            write_error_after: None,
            write_calls: 0,
            random: [3; 32],
            random_error: Some(Errno::ENOSYS),
        };
        assert_eq!(serve_with(&mut io), Err(TransportError::Unsupported));
        assert!(io.output.is_empty());
    }

    #[test]
    fn partial_response_bytes_are_not_a_complete_response() {
        let mut io = Fake {
            now: 1,
            input: request(),
            read_at: 0,
            read_limit: 17,
            output: Vec::new(),
            waits: Vec::new(),
            wait_result: true,
            write_error_after: Some(1),
            write_calls: 0,
            random: [3; 32],
            random_error: None,
        };
        assert_eq!(serve_with(&mut io), Err(TransportError::Io));
        assert_eq!(io.output.len(), 19);
        assert!(Frame::decode(&io.output).is_err());
    }
}
