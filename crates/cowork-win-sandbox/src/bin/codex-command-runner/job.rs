/// Keep process creation and containment failure ordering testable without Win32.
pub(crate) fn spawn_in_job<J, P, E>(
    create_job: impl FnOnce() -> Result<J, E>,
    spawn_process: impl FnOnce() -> Result<P, E>,
    assign_process: impl FnOnce(&J, &P) -> Result<(), E>,
    discard_process: impl FnOnce(P, E) -> E,
) -> Result<(J, P), E> {
    let job = create_job()?;
    let process = spawn_process()?;
    if let Err(error) = assign_process(&job, &process) {
        return Err(discard_process(process, error));
    }
    Ok((job, process))
}

#[cfg(test)]
mod tests {
    use super::spawn_in_job;
    use std::cell::RefCell;
    use std::rc::Rc;

    type Events = Rc<RefCell<Vec<&'static str>>>;

    #[derive(Debug)]
    struct Handle {
        events: Events,
        drop_event: &'static str,
    }

    impl Drop for Handle {
        fn drop(&mut self) {
            self.events.borrow_mut().push(self.drop_event);
        }
    }

    fn handle(events: &Events, drop_event: &'static str) -> Handle {
        Handle {
            events: Rc::clone(events),
            drop_event,
        }
    }

    #[test]
    fn job_creation_failure_never_spawns_a_child() {
        let events = Events::default();
        let result = spawn_in_job(
            || -> Result<Handle, &str> {
                events.borrow_mut().push("create job");
                Err("create failed")
            },
            || {
                events.borrow_mut().push("spawn child");
                Ok(handle(&events, "close child"))
            },
            |_, _| panic!("must not assign without a job"),
            |_, error| error,
        );
        assert_eq!(result.unwrap_err(), "create failed");
        assert_eq!(*events.borrow(), ["create job"]);
    }

    #[test]
    fn spawn_failure_releases_the_job_without_assignment() {
        let events = Events::default();
        let result = spawn_in_job(
            || {
                events.borrow_mut().push("create job");
                Ok(handle(&events, "close job"))
            },
            || -> Result<Handle, &str> {
                events.borrow_mut().push("spawn child");
                Err("spawn failed")
            },
            |_, _| panic!("must not assign a missing child"),
            |_, error| error,
        );
        assert_eq!(result.unwrap_err(), "spawn failed");
        assert_eq!(*events.borrow(), ["create job", "spawn child", "close job"]);
    }

    #[test]
    fn assignment_failure_terminates_and_releases_the_child_before_returning() {
        let events = Events::default();
        let result = spawn_in_job(
            || {
                events.borrow_mut().push("create job");
                Ok(handle(&events, "close job"))
            },
            || {
                events.borrow_mut().push("spawn child");
                Ok(handle(&events, "close child"))
            },
            |_, _| {
                events.borrow_mut().push("assign child");
                Err("assign failed")
            },
            |child, error| {
                events.borrow_mut().push("terminate child");
                drop(child);
                error
            },
        );
        assert_eq!(result.unwrap_err(), "assign failed");
        assert_eq!(
            *events.borrow(),
            [
                "create job",
                "spawn child",
                "assign child",
                "terminate child",
                "close child",
                "close job"
            ]
        );
    }

    #[test]
    fn successful_spawn_keeps_job_ownership_until_the_caller_releases_it() {
        let events = Events::default();
        let contained = spawn_in_job(
            || {
                events.borrow_mut().push("create job");
                Ok(handle(&events, "close job"))
            },
            || {
                events.borrow_mut().push("spawn child");
                Ok(handle(&events, "close child"))
            },
            |_, _| {
                events.borrow_mut().push("assign child");
                Ok::<_, &str>(())
            },
            |_, _| panic!("must not terminate a contained child"),
        )
        .unwrap();
        assert_eq!(
            *events.borrow(),
            ["create job", "spawn child", "assign child"]
        );
        drop(contained);
        assert_eq!(
            *events.borrow(),
            [
                "create job",
                "spawn child",
                "assign child",
                "close job",
                "close child"
            ]
        );
    }
}
