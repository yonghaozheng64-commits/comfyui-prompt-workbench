import unittest
from backend.queue_status import collect_status, task_metadata


def task(prompt_id, run='run', index=0):
    return [0, prompt_id, {}, {'prompt_workbench_template_task': {'batchRunId': run, 'batchJobIndex': index}}]


class Queue:
    def get_current_queue_volatile(self):
        return [task('retry')], []

    def get_history(self, map_function=None):
        return {'old': map_function({'prompt': task('old'), 'status': {'completed': True, 'status_str': 'error'}})}


class LegacyQueue:
    def get_current_queue(self):
        return [], [task('pending')]

    def get_history(self):
        raise AssertionError('Legacy history must not copy all workflows')


class StatusTests(unittest.TestCase):
    def test_failed_is_not_success_and_running_retry_wins(self):
        result = collect_status(Queue(), {'run_id': 'run'})
        self.assertEqual(result['statuses']['old']['status'], 'failed')
        self.assertEqual(result['by_job']['0']['promptId'], 'retry')

    def test_legacy_queue_fallback(self):
        result = collect_status(LegacyQueue(), {'run_id': 'run'})
        self.assertTrue(result['queueOnly'])
        self.assertEqual(result['by_job']['0']['status'], 'pending')

    def test_unrelated_tasks_are_excluded(self):
        self.assertEqual(collect_status(Queue(), {'run_id': 'other'})['statuses'], {})

    def test_malformed_metadata(self):
        for item in (None, [], [0, 'x', {}, None]):
            self.assertEqual(task_metadata(item), {})


if __name__ == '__main__':
    unittest.main()
