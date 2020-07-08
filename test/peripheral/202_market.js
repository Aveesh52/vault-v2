// External
const Vat = artifacts.require('Vat');
const GemJoin = artifacts.require('GemJoin');
const DaiJoin = artifacts.require('DaiJoin');
const Weth = artifacts.require("WETH9");
const ERC20 = artifacts.require("TestERC20");
const Jug = artifacts.require('Jug');
const Pot = artifacts.require('Pot');
const End = artifacts.require('End');
const Chai = artifacts.require('Chai');
const GasToken = artifacts.require('GasToken1');

// Common
const Treasury = artifacts.require('Treasury');

// YDai
const YDai = artifacts.require('YDai');
const Dealer = artifacts.require('Dealer');

// Peripheral
const EthProxy = artifacts.require('EthProxy');
const Unwind = artifacts.require('Unwind');
const Market = artifacts.require('Market');

// Mocks
const FlashMinterMock = artifacts.require('FlashMinterMock');

const truffleAssert = require('truffle-assertions');
const helper = require('ganache-time-traveler');
const { toWad, toRay, toRad, addBN, subBN, mulRay, divRay } = require('../shared/utils');
const { BN, expectEvent, expectRevert } = require('@openzeppelin/test-helpers');
const { assert, expect } = require('chai');

contract('Market', async (accounts) =>  {
    let [ owner, user1, user2 ] = accounts;
    let vat;
    let weth;
    let wethJoin;
    let dai;
    let daiJoin;
    let jug;
    let pot;
    let end;
    let chai;
    let gasToken;
    let treasury;
    let yDai1;
    let yDai2;
    let dealer;
    let splitter;
    let market;
    let flashMinter;

    let ilk = web3.utils.fromAscii("ETH-A");
    let Line = web3.utils.fromAscii("Line");
    let spotName = web3.utils.fromAscii("spot");
    let linel = web3.utils.fromAscii("line");

    const limits =  toRad(10000);
    const spot = toRay(1.2);

    const rate1 = toRay(1.4);
    const chi1 = toRay(1.2);
    const rate2 = toRay(1.82);
    const chi2 = toRay(1.5);

    const chiDifferential  = divRay(chi2, chi1);

    const daiDebt1 = toWad(96);
    const daiTokens1 = mulRay(daiDebt1, rate1);
    const yDaiTokens1 = daiTokens1;
    const wethTokens1 = divRay(daiTokens1, spot);
    const chaiTokens1 = divRay(daiTokens1, chi1);

    const daiTokens2 = mulRay(daiTokens1, chiDifferential);
    const wethTokens2 = mulRay(wethTokens1, chiDifferential)

    let maturity;

    // Scenario in which the user mints daiTokens2 yDai1, chi increases by a 25%, and user redeems daiTokens1 yDai1
    const daiDebt2 = mulRay(daiDebt1, chiDifferential);
    const savings1 = daiTokens2;
    const savings2 = mulRay(savings1, chiDifferential);
    const yDaiSurplus = subBN(daiTokens2, daiTokens1);
    const savingsSurplus = subBN(savings2, daiTokens2);

    // Convert eth to weth and use it to borrow `daiTokens` from MakerDAO
    // This function shadows and uses global variables, careful.
    async function getDai(user, daiTokens){
        await vat.hope(daiJoin.address, { from: user });
        await vat.hope(wethJoin.address, { from: user });

        const daiDebt = divRay(daiTokens, rate1);
        const wethTokens = divRay(daiTokens, spot);

        await weth.deposit({ from: user, value: wethTokens });
        await weth.approve(wethJoin.address, wethTokens, { from: user });
        await wethJoin.join(user, wethTokens, { from: user });
        await vat.frob(ilk, user, user, user, wethTokens, daiDebt, { from: user });
        await daiJoin.exit(user, daiTokens, { from: user });
    }

    // From eth, borrow `daiTokens` from MakerDAO and convert them to chai
    // This function shadows and uses global variables, careful.
    async function getChai(user, chaiTokens){
        const daiTokens = mulRay(chaiTokens, chi1);
        await getDai(user, daiTokens);
        await dai.approve(chai.address, daiTokens, { from: user });
        await chai.join(user, daiTokens, { from: user });
    }

    beforeEach(async() => {
        snapshot = await helper.takeSnapshot();
        snapshotId = snapshot['result'];

        // Setup vat, join and weth
        vat = await Vat.new();
        await vat.init(ilk, { from: owner }); // Set ilk rate (stability fee accumulator) to 1.0

        weth = await Weth.new({ from: owner });
        wethJoin = await GemJoin.new(vat.address, ilk, weth.address, { from: owner });

        dai = await ERC20.new(0, { from: owner });
        daiJoin = await DaiJoin.new(vat.address, dai.address, { from: owner });

        await vat.file(ilk, spotName, spot, { from: owner });
        await vat.file(ilk, linel, limits, { from: owner });
        await vat.file(Line, limits);

        // Setup jug
        jug = await Jug.new(vat.address);
        await jug.init(ilk, { from: owner }); // Set ilk duty (stability fee) to 1.0

        // Setup pot
        pot = await Pot.new(vat.address);

        // Permissions
        await vat.rely(vat.address, { from: owner });
        await vat.rely(wethJoin.address, { from: owner });
        await vat.rely(daiJoin.address, { from: owner });
        await vat.rely(jug.address, { from: owner });
        await vat.rely(pot.address, { from: owner });
        await vat.hope(daiJoin.address, { from: owner });

        // Setup chai
        chai = await Chai.new(
            vat.address,
            pot.address,
            daiJoin.address,
            dai.address,
        );

        treasury = await Treasury.new(
            vat.address,
            weth.address,
            dai.address,
            wethJoin.address,
            daiJoin.address,
            pot.address,
            chai.address,
        );
    
        // Setup yDai1
        const block = await web3.eth.getBlockNumber();
        maturity = (await web3.eth.getBlock(block)).timestamp + 31556952; // One year
        yDai1 = await YDai.new(
            vat.address,
            jug.address,
            pot.address,
            treasury.address,
            maturity,
            "Name",
            "Symbol"
        );
        await treasury.orchestrate(yDai1.address, { from: owner });

        // Setup Market
        market = await Market.new(
            pot.address,
            chai.address,
            yDai1.address,
            { from: owner }
        );

        // Test setup
        
        // Increase the rate accumulator
        await vat.fold(ilk, vat.address, subBN(rate1, toRay(1)), { from: owner }); // Fold only the increase from 1.0
        await pot.setChi(chi1, { from: owner }); // Set the savings accumulator

        // Allow owner to mint yDai the sneaky way, without recording a debt in dealer
        await yDai1.orchestrate(owner, { from: owner });

    });

    afterEach(async() => {
        await helper.revertToSnapshot(snapshotId);
    });

    it("get the size of the contract", async() => {
        console.log();
        console.log("    ·--------------------|------------------|------------------|------------------·");
        console.log("    |  Contract          ·  Bytecode        ·  Deployed        ·  Constructor     |");
        console.log("    ·····················|··················|··················|···················");
        
        const bytecode = market.constructor._json.bytecode;
        const deployed = market.constructor._json.deployedBytecode;
        const sizeOfB  = bytecode.length / 2;
        const sizeOfD  = deployed.length / 2;
        const sizeOfC  = sizeOfB - sizeOfD;
        console.log(
            "    |  " + (market.constructor._json.contractName).padEnd(18, ' ') +
            "|" + ("" + sizeOfB).padStart(16, ' ') + "  " +
            "|" + ("" + sizeOfD).padStart(16, ' ') + "  " +
            "|" + ("" + sizeOfC).padStart(16, ' ') + "  |");
        console.log("    ·--------------------|------------------|------------------|------------------·");
        console.log();
    });

    it("should setup market", async() => {
        const b = new BN('18446744073709551615');
        const k = b.div((new BN('126144000')));
        expect(await market.k()).to.be.bignumber.equal(k);

        const g = (new BN('999')).mul(b).div(new BN('1000')).add(new BN(1)); // Close enough
        expect(new BN(await market.g())).to.be.bignumber.equal(g);
    });

    it("adds initial liquidity", async() => {
        await getChai(user1, chaiTokens1)
        await yDai1.mint(user1, yDaiTokens1, { from: owner });

        await chai.approve(market.address, chaiTokens1, { from: user1 });
        await yDai1.approve(market.address, yDaiTokens1, { from: user1 });
        await market.init(chaiTokens1, yDaiTokens1, { from: user1 });

        assert.equal(
            await market.balanceOf(user1),
            1000,
            "User1 should have 1000 liquidity tokens",
        );
    });

    describe("with liquidity", () => {
        beforeEach(async() => {
            await getChai(user1, chaiTokens1)
            await yDai1.mint(user1, yDaiTokens1, { from: owner });
    
            await chai.approve(market.address, chaiTokens1, { from: user1 });
            await yDai1.approve(market.address, yDaiTokens1, { from: user1 });
            await market.init(chaiTokens1, yDaiTokens1, { from: user1 });
        });

        it("mints liquidity tokens", async() => {
            await getChai(user1, chaiTokens1)
            await yDai1.mint(user1, yDaiTokens1, { from: owner });

            await chai.approve(market.address, chaiTokens1, { from: user1 });
            await yDai1.approve(market.address, yDaiTokens1, { from: user1 });
            await market.mint(chaiTokens1, { from: user1 });

            assert.equal(
                await market.balanceOf(user1),
                2000,
                "User1 should have 2000 liquidity tokens",
            );
        });

        it("burns liquidity tokens", async() => {
            await market.approve(market.address, 500, { from: user1 });
            await market.burn(500, { from: user1 });

            assert.equal(
                await chai.balanceOf(user1),
                chaiTokens1.div(2).toString(),
                "User1 should have chai tokens",
            );
            assert.equal(
                await yDai1.balanceOf(user1),
                yDaiTokens1.div(2).toString(),
                "User1 should have yDai tokens",
            );
        });

        it("sells chai", async() => {
            const b = new BN('18446744073709551615');
            const r = new BN('1000000000000000000000000000');
            const oneToken = toWad(1);
            await getChai(user2, chaiTokens1);

            // yDaiOutForChaiIn formula: https://www.desmos.com/calculator/dcjuj5lmmc
            // uint256 yDaiOut = YieldMath.yDaiOutForChaiIn(
            //   chaiReserves, yDaiReserves,
            //   chaiIn,
            //   uint128(maturity - now), k, c, g
            // );

            console.log("          selling chai...");
            console.log("          chaiReserves: %d", await chai.balanceOf(market.address));
            console.log("          yDaiReserves: %d", await yDai1.balanceOf(market.address));
            console.log("          chaiIn: %d", oneToken.toString());
            console.log("          k: %d", await market.k());
            console.log("          c: %d", (new BN(await pot.chi()).mul(b).div(r)).toString());
            console.log("          g: %d", await market.g());
            const t = new BN((await web3.eth.getBlock(await web3.eth.getBlockNumber())).timestamp);
            console.log("          timeTillMaturity: %d", (new BN(maturity).sub(t).toString()));

            assert.equal(
                await yDai1.balanceOf(user2),
                0,
                "User2 should have no yDai, instead has " + await yDai1.balanceOf(user2),
            );

            await chai.approve(market.address, oneToken, { from: user2 });
            await market.sellChai(oneToken, { from: user2 });

            assert.equal(
                await chai.balanceOf(user2),
                chaiTokens1.sub(oneToken).toString(),
                "User2 should not have chai tokens",
            );

            const expectedYDaiOut = (new BN(oneToken.toString())).mul(new BN('1436')).div(new BN('1000')); // I just hate javascript
            const yDaiOut = new BN(await yDai1.balanceOf(user2));
            expect(yDaiOut).to.be.bignumber.gt(expectedYDaiOut.mul(new BN('99')).div(new BN('100')));
            expect(yDaiOut).to.be.bignumber.lt(expectedYDaiOut.mul(new BN('101')).div(new BN('100')));
        });

        it("buys chai", async() => {
            const b = new BN('18446744073709551615');
            const r = new BN('1000000000000000000000000000');
            const oneToken = toWad(1);
            await yDai1.mint(user2, yDaiTokens1, { from: owner });

            // yDaiInForChaiOut formula: https://www.desmos.com/calculator/16c4dgxhst
            
            // uint256 yDaiIn = YieldMath.yDaiInForChaiOut(
            //   chaiReserves, yDaiReserves,
            //   chaiOut,
            //   uint128(maturity - now), k, c, g
            // );

            console.log("          buying chai...");
            console.log("          chaiReserves: %d", await chai.balanceOf(market.address));
            console.log("          yDaiReserves: %d", await yDai1.balanceOf(market.address));
            console.log("          chaiOut: %d", oneToken.toString());
            console.log("          k: %d", await market.k());
            console.log("          c: %d", (new BN(await pot.chi()).mul(b).div(r)).toString());
            console.log("          g: %d", await market.g());
            const t = new BN((await web3.eth.getBlock(await web3.eth.getBlockNumber())).timestamp);
            console.log("          timeTillMaturity: %d", (new BN(maturity).sub(t).toString()));

            assert.equal(
                await yDai1.balanceOf(user2),
                yDaiTokens1.toString(),
                "User2 should have " + yDaiTokens1 + " yDai, instead has " + await yDai1.balanceOf(user2),
            );

            await yDai1.approve(market.address, yDaiTokens1, { from: user2 });
            await market.buyChai(oneToken, { from: user2 });

            assert.equal(
                await chai.balanceOf(user2),
                oneToken.toString(),
                "User2 should not have chai tokens",
            );

            const expectedYDaiIn = (new BN(oneToken.toString())).mul(new BN('14435')).div(new BN('10000')); // I just hate javascript
            const yDaiIn = (new BN(yDaiTokens1.toString())).sub(new BN(await yDai1.balanceOf(user2)));
            expect(yDaiIn).to.be.bignumber.gt(expectedYDaiIn.mul(new BN('99')).div(new BN('100')));
            expect(yDaiIn).to.be.bignumber.lt(expectedYDaiIn.mul(new BN('101')).div(new BN('100')));
        });

        // chaiOutForYDaiIn formula: https://www.desmos.com/calculator/avmxfau7j0
        // chaiInForYDaiOut formula: https://www.desmos.com/calculator/meuwnwtmc0
    });
});