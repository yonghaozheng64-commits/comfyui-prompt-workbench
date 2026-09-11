import inspect


def task_metadata(item):
    try:
        extra = item[3]
        metadata = extra.get('extra_pnginfo', {}).get('workflow', {}).get('extra', {}).get('prompt_workbench_template_task')
        if metadata is None:
            metadata = extra.get('prompt_workbench_template_task', {})
        return metadata if isinstance(metadata, dict) else {}
    except (IndexError, TypeError, AttributeError):
        return {}


def compact_history(item):
    task = item.get('prompt') or []
    status = item.get('status') or {}
    return {
        'prompt_id': task[1] if len(task) > 1 else '',
        'metadata': task_metadata(task),
        # ComfyUI also marks failed execution as completed.
        'completed': bool(status.get('completed')) and status.get('status_str') == 'success',
    }


def collect_status(queue, payload):
    run_id = str(payload.get('run_id') or '')
    requested_ids = set(map(str, payload.get('prompt_ids') or []))
    signatures = set(map(str, payload.get('signatures') or []))
    result = {'statuses': {}, 'by_job': {}, 'by_signature': {}}

    def record(prompt_id, status, metadata):
        prompt_id = str(prompt_id or '')
        own_run = bool(run_id) and metadata.get('batchRunId') == run_id
        signature = f"{metadata.get('template') or ''}\u001f{metadata.get('character') or ''}"
        if not prompt_id or not (own_run or prompt_id in requested_ids or signature in signatures):
            return
        entry = {'promptId': prompt_id, 'status': status}
        result['statuses'][prompt_id] = entry
        if own_run:
            try:
                result['by_job'][str(int(metadata['batchJobIndex']))] = entry
            except (KeyError, ValueError, TypeError):
                pass
        if signature in signatures:
            result['by_signature'].setdefault(signature, []).append(entry)

    if 'map_function' in inspect.signature(queue.get_history).parameters:
        history = queue.get_history(map_function=compact_history)
        for item in history.values():
            record(item['prompt_id'], 'completed' if item['completed'] else 'failed', item['metadata'])
    else:
        result['queueOnly'] = True
    get_queue = getattr(queue, 'get_current_queue_volatile', None) or queue.get_current_queue
    running, pending = get_queue()
    for items, status in ((pending, 'pending'), (running, 'running')):
        for item in items:
            if len(item) > 1:
                record(item[1], status, task_metadata(item))
    return result
