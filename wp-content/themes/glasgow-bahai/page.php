<?php
/**
 * The template for displaying standard pages.
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

get_header();
?>

<div class="page-hero">
	<div class="container">
		<h1><?php the_title(); ?></h1>
	</div>
</div>

<main id="primary" class="site-main">
	<?php
	while ( have_posts() ) :
		the_post();
		get_template_part( 'template-parts/content', 'page' );

		if ( comments_open() || get_comments_number() ) {
			comments_template();
		}
	endwhile;
	?>
</main>

<?php get_footer(); ?>
