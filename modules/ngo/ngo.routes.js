const express = require('express');
const ngo = require('./ngo.service');
const { requireAuth, requirePermission } = require('../../middleware/auth');

const router = express.Router();
router.use(requireAuth, requirePermission('inventory:manage'));

router.get('/dashboard', async (req, res) => {
    res.json(await ngo.dashboard(req.user, req.query.providerId && String(req.query.providerId)));
});

router.post('/lodgings', async (req, res) => {
    res.status(201).json(await ngo.addLodging(req.user, req.body || {}));
});

router.patch('/lodgings/:id/beds', async (req, res) => {
    res.json(await ngo.adjustBeds(req.user, req.params.id, req.body && req.body.change));
});

router.post('/food-centers', async (req, res) => {
    res.status(201).json(await ngo.addFoodCenter(req.user, req.body || {}));
});

router.put('/food-centers/:id/slots', async (req, res) => {
    res.json(await ngo.setSlot(req.user, req.params.id, req.body || {}));
});

module.exports = router;
