//! Bounded, descriptor-only transport for the initial OpenStable handshake.

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

fn serve_with<I: Io>(io: &mut I) -> Result<(), TransportError> {
    let start = io.now_millis().map_err(classify_io_error)?;
    let deadline = start
        .checked_add(OPEN_STABLE_FRAME_DEADLINE_MS)
        .ok_or(TransportError::Io)?;
    let mut pending = Vec::with_capacity(MAX_FRAME_LEN + READ_CHUNK);
    let request = read_frame(io, deadline, &mut pending)?;
    if request.kind != MessageKind::Request(RequestKind::OpenStable)
        || !request.session_id.iter().all(|byte| *byte == 0)
        || request.ordinal != 0
        || !request.payload.is_empty()
    {
        return Err(TransportError::Protocol);
    }
    let mut session_id = [0_u8; 32];
    io.random(&mut session_id).map_err(|error| {
        if error == Errno::ENOSYS {
            TransportError::Unsupported
        } else {
            TransportError::Entropy
        }
    })?;
    if session_id.iter().all(|byte| *byte == 0) {
        return Err(TransportError::Entropy);
    }
    let response = protocol::open_stable_response(request.request_id, session_id)
        .map_err(|_| TransportError::Protocol)?;
    write_all(io, deadline, &response)
}

pub(crate) fn serve_open_stable() -> Result<(), TransportError> {
    serve_with(&mut LinuxIo {
        input: 0,
        output: 1,
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
    fn request() -> Vec<u8> {
        Frame {
            kind: MessageKind::Request(RequestKind::OpenStable),
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
            random: [3; 32],
            random_error: Some(Errno::ENOSYS),
        };
        assert_eq!(serve_with(&mut io), Err(TransportError::Unsupported));
        assert!(io.output.is_empty());
    }
}
