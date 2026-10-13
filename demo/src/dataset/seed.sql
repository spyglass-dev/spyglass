-- Lighthouse Outfitters: a fictional outdoor-gear store, two years of trading
-- ending yesterday. Deterministic: every "random" draw is a hash of the row's
-- key, so the same date produces the same dataset on every machine.
-- Runs in DuckDB (in the browser via duckdb-wasm, or the duckdb CLI).

create or replace macro r(a, b, c) as (hash(a, b, c) % 1000003) / 1000003.0;
create or replace macro pick(xs, u) as xs[1 + least(floor(u * len(xs))::int, len(xs) - 1)];

create or replace table products as
select * from (values
  (1,  'Summit 2P Tent',          'Tents',        'Backpacking tents', 389.0, 171.0),
  (2,  'Basecamp 4P Tent',        'Tents',        'Family tents',      529.0, 248.0),
  (3,  'Ridgeline Ultralight 1P', 'Tents',        'Backpacking tents', 449.0, 189.0),
  (4,  'Harbor Shelter Tarp',     'Tents',        'Shelters',           89.0,  31.0),
  (5,  'Trailhead 28L Daypack',   'Packs',        'Daypacks',          119.0,  44.0),
  (6,  'Traverse 55L Pack',       'Packs',        'Trekking packs',    259.0, 102.0),
  (7,  'Expedition 70L Pack',     'Packs',        'Trekking packs',    339.0, 141.0),
  (8,  'Commuter Sling',          'Packs',        'Daypacks',           59.0,  19.0),
  (9,  'Granite Mid Boot',        'Footwear',     'Hiking boots',      189.0,  78.0),
  (10, 'Scree Trail Runner',      'Footwear',     'Trail runners',     149.0,  58.0),
  (11, 'Alpine GTX Boot',         'Footwear',     'Mountaineering',    329.0, 146.0),
  (12, 'Camp Slide',              'Footwear',     'Camp shoes',         45.0,  14.0),
  (13, 'Storm Shell Jacket',      'Apparel',      'Shells',            279.0, 104.0),
  (14, 'Loft Down Jacket',        'Apparel',      'Insulation',        239.0,  92.0),
  (15, 'Merino Base Layer',       'Apparel',      'Base layers',        89.0,  33.0),
  (16, 'Trail Pant',              'Apparel',      'Pants',              99.0,  36.0),
  (17, 'Sun Hoodie',              'Apparel',      'Base layers',        69.0,  22.0),
  (18, 'Dynamic Rope 60m',        'Climbing',     'Ropes',             229.0,  97.0),
  (19, 'Crag Harness',            'Climbing',     'Harnesses',          79.0,  28.0),
  (20, 'Quickdraw Set',           'Climbing',     'Hardware',          139.0,  52.0),
  (21, 'Bouldering Pad',          'Climbing',     'Pads',              199.0,  81.0),
  (22, 'Titanium Pot Set',        'Camp kitchen', 'Cookware',           79.0,  27.0),
  (23, 'Jet Stove',               'Camp kitchen', 'Stoves',            129.0,  49.0),
  (24, 'Filter Bottle',           'Camp kitchen', 'Water',              45.0,  13.0),
  (25, 'Camp Mug',                'Camp kitchen', 'Cookware',           19.0,   5.0),
  (26, 'Ember 20F Sleeping Bag',  'Sleep',        'Sleeping bags',     299.0, 121.0),
  (27, 'Cirrus Sleeping Pad',     'Sleep',        'Pads',              169.0,  64.0),
  (28, 'Pillow Lite',             'Sleep',        'Pillows',            35.0,  10.0)
) t(id, name, category, subcategory, price, cost);

-- Customers: where they live and how they first found the store.
create or replace table customers as
with base as (
  select i as id,
    pick(['Avery','Jordan','Riley','Sam','Morgan','Casey','Quinn','Rowan','Emery','Kai','Noa','Sage','Hayden','Remy','Ari','Jules','Reese','Skyler','Blake','Devon'], r(i, 1, 0)) as first_name,
    pick(['Okafor','Lindqvist','Tanaka','Moreau','Fischer','Silva','Nakamura','Brennan','Kowalski','Haddad','Larsen','Ivanova','Mendes','Chen','Walsh','Patel','Novak','Dubois','Sato','Reyes'], r(i, 2, 0)) as last_name,
    r(i, 3, 0) as u_geo, r(i, 4, 0) as u_seg, r(i, 5, 0) as u_ch
  from range(1, 6001) t(i)
)
select id,
  first_name || ' ' || last_name as name,
  case when u_geo < 0.44 then 'North America' when u_geo < 0.78 then 'Europe' else 'Asia Pacific' end as region,
  case
    when u_geo < 0.36 then 'United States' when u_geo < 0.44 then 'Canada'
    when u_geo < 0.56 then 'United Kingdom' when u_geo < 0.66 then 'Germany'
    when u_geo < 0.73 then 'France' when u_geo < 0.78 then 'Netherlands'
    when u_geo < 0.87 then 'Australia' when u_geo < 0.95 then 'Japan' else 'Singapore'
  end as country,
  case when u_seg < 0.62 then 'Weekend explorer' when u_seg < 0.9 then 'Enthusiast' else 'Guide & club' end as segment,
  case when u_ch < 0.32 then 'Organic' when u_ch < 0.56 then 'Paid search' when u_ch < 0.72 then 'Email'
       when u_ch < 0.88 then 'Social' else 'Referral' end as acquisition_channel,
  null::timestamp as signed_up_at
from base;

-- Daily demand: growth over the two years, weekends up, a holiday peak,
-- a summer bump, a January lull, and a little noise.
create or replace table days as
select d::date as day,
  round(38
    * (1 + 0.7 * (d::date - (current_date - 730)) / 730.0)
    * case dayofweek(d) when 0 then 1.25 when 6 then 1.3 when 1 then 0.9 else 1.0 end
    * case month(d) when 11 then 1.55 when 12 then 1.85 when 1 then 0.72 when 2 then 0.8
                    when 6 then 1.15 when 7 then 1.25 when 8 then 1.18 else 1.0 end
    * (0.85 + 0.3 * r(d::date, 9, 0))
  )::int as demand
from range(current_date - 730, current_date, interval 1 day) t(d);

create or replace table orders as
with raw as (
  select d.day, i, d.demand,
    r(d.day, i, 1) as u_cust, r(d.day, i, 2) as u_time, r(d.day, i, 3) as u_ch,
    r(d.day, i, 4) as u_dev, r(d.day, i, 5) as u_status, r(d.day, i, 6) as u_disc
  from days d, range(d.demand) t(i)
)
select row_number() over (order by day, i)::int as id,
  -- skew toward repeat customers: lower ids order more often
  1 + floor(power(u_cust, 1.25) * 6000)::int as customer_id,
  day + to_seconds(floor(u_time * 86399)::bigint) as ordered_at,
  case when u_ch < 0.33 then 'Organic' when u_ch < 0.57 then 'Paid search' when u_ch < 0.74 then 'Email'
       when u_ch < 0.88 then 'Social' else 'Referral' end as channel,
  case when u_dev < 0.56 then 'Mobile' when u_dev < 0.93 then 'Desktop' else 'Tablet' end as device,
  case when u_status < 0.035 then 'cancelled' when u_status < 0.105 then 'returned' else 'completed' end as status,
  case
    when month(day) in (11, 12) and u_disc < 0.45 then 0.2
    when u_disc < 0.12 then 0.1 when u_disc < 0.18 then 0.15 else 0.0
  end::double as discount
from raw;

create or replace table order_items as
with lines as (
  select o.id as order_id, o.ordered_at, j,
    r(o.id, j, 7) as u_prod, r(o.id, j, 8) as u_qty
  from orders o, range(1 + floor(r(o.id, 0, 7) * r(o.id, 1, 7) * 3.2)::int) t(j)
)
select row_number() over (order by order_id, j)::int as id, order_id,
  -- seasonal mix: tents and packs in summer, insulation and sleep in winter
  case
    when month(ordered_at) in (5, 6, 7, 8) and u_prod < 0.3 then pick([1, 2, 3, 5, 6, 7, 10, 24], u_prod / 0.3)
    when month(ordered_at) in (11, 12, 1) and u_prod < 0.3 then pick([14, 15, 26, 27, 11, 13, 25, 22], u_prod / 0.3)
    else 1 + floor(power((u_prod - 0.0) , 1.15) * 28)::int
  end as product_id,
  case when u_qty < 0.84 then 1 when u_qty < 0.96 then 2 else 3 end as quantity
from lines;

-- Clamp generated product ids into range (the power curve can land on 29).
update order_items set product_id = 28 where product_id > 28;

-- Footwear comes back more often: re-mark some footwear orders as returned.
update orders set status = 'returned'
where status = 'completed' and r(id, 0, 11) < 0.09
  and id in (select oi.order_id from order_items oi join products p on p.id = oi.product_id where p.category = 'Footwear');

-- Sign-up date: a little before a customer's first order; never-ordered
-- customers signed up somewhere in the window.
update customers c set signed_up_at = f.first_at - to_days(floor(r(c.id, 6, 0) * 20)::int)
from (select customer_id, min(ordered_at) as first_at from orders group by 1) f
where f.customer_id = c.id;
update customers set signed_up_at = (current_date - 730) + to_seconds(floor(r(id, 7, 0) * 730 * 86400)::bigint)
where signed_up_at is null;

-- Web traffic, pre-aggregated by day x channel x device: the funnel from
-- session to purchase. Purchases tie back to the day's orders.
create or replace table traffic as
with grid as (
  select d.day, ch.channel, dv.device, d.demand,
    case ch.channel when 'Organic' then 0.30 when 'Paid search' then 0.27 when 'Email' then 0.12
                    when 'Social' then 0.21 else 0.10 end as ch_share,
    case dv.device when 'Mobile' then 0.64 when 'Desktop' then 0.29 else 0.07 end as dv_share,
    case ch.channel when 'Email' then 0.046 when 'Referral' then 0.038 when 'Organic' then 0.027
                    when 'Paid search' then 0.022 else 0.012 end as ch_cr,
    case dv.device when 'Desktop' then 1.45 when 'Tablet' then 1.0 else 0.78 end as dv_cr
  from days d,
    (values ('Organic'), ('Paid search'), ('Email'), ('Social'), ('Referral')) ch(channel),
    (values ('Mobile'), ('Desktop'), ('Tablet')) dv(device)
)
select day, channel, device,
  round(demand * 36 * ch_share * dv_share * (0.9 + 0.2 * r(day, hash(channel), hash(device))))::int as sessions,
  round(demand * 36 * ch_share * dv_share * (0.9 + 0.2 * r(day, hash(channel), hash(device))) * 0.19 * (ch_cr / 0.027) ^ 0.5)::int as carts,
  round(demand * 36 * ch_share * dv_share * (0.9 + 0.2 * r(day, hash(channel), hash(device))) * 0.08 * (ch_cr / 0.027) ^ 0.7 * dv_cr ^ 0.5)::int as checkouts,
  round(demand * 36 * ch_share * dv_share * (0.9 + 0.2 * r(day, hash(channel), hash(device))) * ch_cr * dv_cr)::int as purchases
from grid;

-- Order totals, from their lines, net of discount.
alter table orders add column gross double;
alter table orders add column revenue double;
alter table orders add column cost double;
alter table orders add column units int;
update orders o set gross = t.gross, revenue = round(t.gross * (1 - o.discount), 2), cost = t.cost, units = t.units
from (
  select oi.order_id, sum(oi.quantity * p.price) as gross, sum(oi.quantity * p.cost) as cost, sum(oi.quantity)::int as units
  from order_items oi join products p on p.id = oi.product_id group by 1
) t where t.order_id = o.id;

drop table days;
